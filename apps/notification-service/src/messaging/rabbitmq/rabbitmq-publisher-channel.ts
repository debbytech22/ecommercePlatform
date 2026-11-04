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
    await channel?.close().catch((e: unknown) =>
      this.logger.warn(`Failed closing notification publisher channel: ${this.safeError(e)}`),
    );
    await connection?.close().catch((e: unknown) =>
      this.logger.warn(`Failed closing notification publisher connection: ${this.safeError(e)}`),
    );
  }

  getConfirmChannel(): amqp.ConfirmChannel {
    if (!this.channel) throw new Error('Notification RabbitMQ publisher is disconnected');
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
      this.logger.error('RABBITMQ_URL is missing; notification outbox is paused');
      this.scheduleReconnect();
      return;
    }
    let connection: amqp.ChannelModel | undefined;
    try {
      connection = await amqp.connect(url);
      const channel = await connection.createConfirmChannel();
      await channel.assertExchange(
        this.config.get<string>('RABBITMQ_EVENTS_EXCHANGE', 'ecommerce.events'),
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
      connection.on('error', (e) =>
        this.logger.error(`Notification RabbitMQ publisher error: ${e.message}`),
      );
      channel.on('close', () => this.disconnected(connection));
      channel.on('error', (e) =>
        this.logger.error(`Notification RabbitMQ publisher channel error: ${e.message}`),
      );
    } catch (error) {
      await connection?.close().catch(() => undefined);
      this.logger.error(
        `Notification RabbitMQ publisher unavailable: ${this.safeError(error)}`,
      );
      this.scheduleReconnect();
    }
  }

  private disconnected(connection: amqp.ChannelModel | undefined): void {
    if (!connection || this.connection !== connection || this.stopping) return;
    this.connection = undefined;
    this.channel = undefined;
    void connection.close().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private safeError(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.replace(/amqps?:\/\/[^@\s]+@/gi, 'amqp://[redacted]@');
  }
}
