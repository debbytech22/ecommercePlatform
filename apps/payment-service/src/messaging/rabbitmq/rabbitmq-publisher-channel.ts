import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';

@Injectable()
export class RabbitMqPublisherChannel implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqPublisherChannel.name);
  private connection: amqp.ChannelModel | undefined;
  private channel: amqp.ConfirmChannel | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connecting: Promise<void> | undefined;
  private reconnectAttempt = 0;
  private stopping = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const channel = this.channel;
    const connection = this.connection;
    this.channel = undefined;
    this.connection = undefined;
    await channel
      ?.close()
      .catch((error: unknown) =>
        this.logger.warn(
          `Failed closing Payment publisher channel: ${this.safeError(error)}`,
        ),
      );
    await connection
      ?.close()
      .catch((error: unknown) =>
        this.logger.warn(
          `Failed closing Payment publisher connection: ${this.safeError(error)}`,
        ),
      );
  }

  getConfirmChannel(): amqp.ConfirmChannel {
    if (!this.channel) {
      throw new Error('RabbitMQ publisher is disconnected');
    }
    return this.channel;
  }

  private async connect(): Promise<void> {
    if (this.stopping || this.channel) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connectOnce(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.error('RABBITMQ_URL is missing; payment outbox is paused');
      this.scheduleReconnect();
      return;
    }

    let connection: amqp.ChannelModel | undefined;
    try {
      const parsed = new URL(url);
      if (
        (parsed.protocol !== 'amqp:' && parsed.protocol !== 'amqps:') ||
        !parsed.hostname ||
        !parsed.username ||
        !parsed.password
      ) {
        throw new Error('RABBITMQ_URL must include AMQP credentials and host');
      }
      if (
        this.config.get<string>('RABBITMQ_TLS_REQUIRED') === 'true' &&
        parsed.protocol !== 'amqps:'
      ) {
        throw new Error('RABBITMQ_TLS_REQUIRED requires an amqps:// URL');
      }
      connection = await amqp.connect(url);
      const channel = await connection.createConfirmChannel();
      await channel.assertExchange(
        this.config.get<string>('RABBITMQ_ORDERS_EXCHANGE', 'ecommerce.events'),
        'topic',
        { durable: true },
      );
      if (this.stopping) {
        await channel.close();
        await connection.close();
        return;
      }
      this.connection = connection;
      this.channel = channel;
      this.reconnectAttempt = 0;
      connection.on('close', () => this.disconnected(connection));
      connection.on('error', (error) =>
        this.logger.error(`RabbitMQ publisher error: ${error.message}`),
      );
      channel.on('close', () => this.disconnected(connection));
      channel.on('error', (error) =>
        this.logger.error(`RabbitMQ publisher channel error: ${error.message}`),
      );
    } catch (error) {
      await connection
        ?.close()
        .catch((closeError: unknown) =>
          this.logger.warn(
            `Failed cleaning Payment RabbitMQ connection: ${this.safeError(closeError)}`,
          ),
        );
      this.logger.error(
        `Payment RabbitMQ publisher unavailable: ${this.safeError(error)}`,
      );
      this.scheduleReconnect();
    }
  }

  private disconnected(connection: amqp.ChannelModel | undefined): void {
    if (!connection || this.connection !== connection || this.stopping) return;
    this.connection = undefined;
    this.channel = undefined;
    void connection
      .close()
      .catch((error: unknown) =>
        this.logger.warn(
          `Failed closing disconnected RabbitMQ publisher: ${this.safeError(error)}`,
        ),
      );
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(
      30_000,
      1000 * 2 ** Math.min(this.reconnectAttempt, 5),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private safeError(error: unknown): string {
    return this.errorMessage(error).replace(/amqps?:\/\/[^@\s]+@/gi, (url) =>
      url.startsWith('amqps:') ? 'amqps://[redacted]@' : 'amqp://[redacted]@',
    );
  }
}
