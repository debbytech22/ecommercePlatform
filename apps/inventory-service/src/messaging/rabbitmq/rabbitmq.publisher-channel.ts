import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { ConnectionOptions } from 'node:tls';

import { InventoryMetricsService } from '../../observability/inventory-metrics.service';

@Injectable()
export class RabbitMqPublisherChannel implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqPublisherChannel.name);
  private readonly exchange: string;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly tlsRequired: boolean;
  private connection: amqp.ChannelModel | undefined;
  private channel: amqp.ConfirmChannel | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connecting: Promise<void> | undefined;
  private reconnectAttempt = 0;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: InventoryMetricsService,
  ) {
    this.exchange = config.get<string>(
      'RABBITMQ_ORDERS_EXCHANGE',
      'ecommerce.events',
    );
    this.reconnectBaseDelayMs = this.readPositiveInteger(
      'RABBITMQ_RECONNECT_BASE_DELAY_MS',
      1000,
    );
    this.reconnectMaxDelayMs = this.readPositiveInteger(
      'RABBITMQ_RECONNECT_MAX_DELAY_MS',
      30000,
    );
    this.tlsRequired = this.readBoolean('RABBITMQ_TLS_REQUIRED', false);
    if (this.reconnectMaxDelayMs < this.reconnectBaseDelayMs) {
      throw new Error(
        'RABBITMQ_RECONNECT_MAX_DELAY_MS must be greater than or equal to RABBITMQ_RECONNECT_BASE_DELAY_MS',
      );
    }
  }

  onModuleInit(): void {
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.metrics.setRabbitMqConnected('publisher', false);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const channel = this.channel;
    const connection = this.connection;
    this.channel = undefined;
    this.connection = undefined;
    await channel?.close().catch((error: unknown) => {
      this.logger.warn(
        `Failed to close RabbitMQ publisher channel: ${this.errorMessage(error)}`,
      );
    });
    await connection?.close().catch((error: unknown) => {
      this.logger.warn(
        `Failed to close RabbitMQ connection: ${this.errorMessage(error)}`,
      );
    });
  }

  getConfirmChannel(): amqp.ConfirmChannel {
    if (!this.channel) {
      throw new Error('RabbitMQ publisher channel is not connected');
    }
    return this.channel;
  }

  private async connect(): Promise<void> {
    if (this.stopping || this.channel) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connectOnce(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.error(
        'RABBITMQ_URL is missing; inventory outbox publishing is paused',
      );
      this.scheduleReconnect();
      return;
    }

    let connection: amqp.ChannelModel | undefined;
    try {
      const parsedUrl = this.validateUrl(url);
      connection = await amqp.connect(url, this.getTlsOptions(parsedUrl));
      const channel = await connection.createConfirmChannel();
      await channel.assertExchange(this.exchange, 'topic', { durable: true });

      if (this.stopping) {
        await channel.close();
        await connection.close();
        return;
      }

      this.connection = connection;
      this.channel = channel;
      this.reconnectAttempt = 0;
      this.metrics.setRabbitMqConnected('publisher', true);
      connection.on('error', (error) => {
        this.logger.error(
          `RabbitMQ publisher connection error: ${this.errorMessage(error)}`,
        );
      });
      connection.on('close', () => this.handleDisconnect(connection));
      channel.on('error', (error) => {
        this.logger.error(
          `RabbitMQ publisher channel error: ${this.errorMessage(error)}`,
        );
      });
      channel.on('close', () => this.handleDisconnect(connection));
      this.logger.log('Connected to RabbitMQ inventory publisher exchange');
    } catch (error) {
      await connection?.close().catch((closeError: unknown) => {
        this.logger.warn(
          `Failed to close RabbitMQ connection after setup error: ${this.errorMessage(closeError)}`,
        );
      });
      this.logger.error(
        `RabbitMQ inventory publisher unavailable: ${this.errorMessage(error)}`,
      );
      this.metrics.setRabbitMqConnected('publisher', false);
      this.scheduleReconnect();
    }
  }

  private handleDisconnect(connection: amqp.ChannelModel | undefined): void {
    if (!connection || this.connection !== connection || this.stopping) {
      return;
    }
    this.logger.warn('RabbitMQ publisher disconnected; reconnecting');
    this.connection = undefined;
    this.channel = undefined;
    this.metrics.setRabbitMqConnected('publisher', false);
    void connection.close().catch((error: unknown) => {
      this.logger.warn(
        `Failed to close disconnected RabbitMQ connection: ${this.errorMessage(error)}`,
      );
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) {
      return;
    }
    const exponentialDelay = Math.min(
      this.reconnectBaseDelayMs * 2 ** Math.min(this.reconnectAttempt, 30),
      this.reconnectMaxDelayMs,
    );
    const delay = Math.min(
      this.reconnectMaxDelayMs,
      Math.floor(exponentialDelay * (0.5 + Math.random())),
    );
    this.reconnectAttempt += 1;
    this.metrics.recordRabbitMqReconnect('publisher');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private validateUrl(url: string): URL {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('RABBITMQ_URL must be a valid AMQP URL');
    }
    if (parsedUrl.protocol !== 'amqp:' && parsedUrl.protocol !== 'amqps:') {
      throw new Error('RABBITMQ_URL must use amqp:// or amqps://');
    }
    if (!parsedUrl.hostname || !parsedUrl.username || !parsedUrl.password) {
      throw new Error(
        'RABBITMQ_URL must include a hostname and RabbitMQ credentials',
      );
    }
    if (this.tlsRequired && parsedUrl.protocol !== 'amqps:') {
      throw new Error(
        'RABBITMQ_TLS_REQUIRED is enabled, but RABBITMQ_URL does not use amqps://',
      );
    }
    return parsedUrl;
  }

  private getTlsOptions(parsedUrl: URL): ConnectionOptions {
    if (parsedUrl.protocol !== 'amqps:') {
      return {};
    }
    const ca = this.config.get<string>('RABBITMQ_TLS_CA');
    const servername = this.config.get<string>('RABBITMQ_TLS_SERVER_NAME');
    return {
      rejectUnauthorized: true,
      ...(ca ? { ca: [ca.replace(/\\n/g, '\n')] } : {}),
      ...(servername ? { servername } : {}),
    };
  }

  private readBoolean(name: string, defaultValue: boolean): boolean {
    const value = this.config.get<string>(name);
    if (value === undefined) {
      return defaultValue;
    }
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    throw new Error(`${name} must be "true" or "false"`);
  }

  private readPositiveInteger(name: string, defaultValue: number): number {
    const configured = this.config.get<string>(name);
    if (configured === undefined) {
      return defaultValue;
    }
    const value = Number(configured);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
  }

  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/amqps?:\/\/[^@\s]+@/gi, (url) => {
      const protocol = url.startsWith('amqps:') ? 'amqps' : 'amqp';
      return `${protocol}://[redacted]@`;
    });
  }
}
