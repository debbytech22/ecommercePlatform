import {
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import {
  ORDER_CANCELLED_EVENT_TYPE,
  ORDER_CONFIRMED_EVENT_TYPE,
  PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE,
} from 'default/contracts';
import { OrderConfirmedConsumer } from '../consumers/order-confirmed.consumer';
import { OrderCancelledConsumer } from '../consumers/order-cancelled.consumer';
import { PaymentFailedConsumer } from '../consumers/payment-failed.consumer';
import { RabbitMqPublisherChannel } from './rabbitmq-publisher-channel';

const SUBSCRIBED_EVENTS = new Set([
  ORDER_CONFIRMED_EVENT_TYPE,
  ORDER_CANCELLED_EVENT_TYPE,
  PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE,
]);

@Injectable()
export class RabbitMqConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqConsumer.name);
  private readonly exchange: string;
  private readonly queue: string;
  private readonly retryQueue: string;
  private readonly deadLetterExchange: string;
  private readonly deadLetterQueue: string;
  private readonly prefetch: number;
  private readonly maxRetries: number;
  private readonly confirmTimeoutMs: number;
  private connection: amqp.ChannelModel | undefined;
  private channel: amqp.Channel | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connecting: Promise<void> | undefined;
  private reconnectAttempt = 0;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly orderConfirmed: OrderConfirmedConsumer,
    private readonly orderCancelled: OrderCancelledConsumer,
    private readonly paymentFailed: PaymentFailedConsumer,
    private readonly publisherChannel: RabbitMqPublisherChannel,
  ) {
    this.exchange = config.get<string>('RABBITMQ_EVENTS_EXCHANGE', 'ecommerce.events');
    this.queue = config.get<string>('NOTIFICATION_EVENT_QUEUE', 'notification.events');
    this.retryQueue = config.get<string>('NOTIFICATION_EVENT_RETRY_QUEUE', 'notification.events.retry');
    this.deadLetterExchange = config.get<string>('RABBITMQ_DEAD_LETTER_EXCHANGE', 'ecommerce.events.dlx');
    this.deadLetterQueue = config.get<string>('NOTIFICATION_EVENT_DEAD_LETTER_QUEUE', 'notification.events.dlq');
    this.prefetch = this.readPositiveInt(config.get<string>('NOTIFICATION_RABBITMQ_PREFETCH'), 10);
    this.maxRetries = this.readPositiveInt(config.get<string>('NOTIFICATION_EVENT_MAX_RETRIES'), 5);
    this.confirmTimeoutMs = this.readPositiveInt(config.get<string>('RABBITMQ_CONFIRM_TIMEOUT_MS'), 10_000);
  }

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
      this.logger.warn(`Failed closing notification consumer channel: ${this.safeError(e)}`),
    );
    await connection?.close().catch((e: unknown) =>
      this.logger.warn(`Failed closing notification consumer connection: ${this.safeError(e)}`),
    );
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
      this.logger.error('RABBITMQ_URL is missing; notification consumer is paused');
      this.scheduleReconnect();
      return;
    }
    let connection: amqp.ChannelModel | undefined;
    try {
      connection = await amqp.connect(url);
      const channel = await connection.createChannel();
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      await channel.assertExchange(this.deadLetterExchange, 'topic', { durable: true });
      await channel.assertQueue(this.deadLetterQueue, { durable: true });
      await channel.bindQueue(this.deadLetterQueue, this.deadLetterExchange, 'notification.invalid');
      await channel.assertQueue(this.queue, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': this.deadLetterExchange,
          'x-dead-letter-routing-key': 'notification.invalid',
        },
      });
      await channel.assertQueue(this.retryQueue, {
        durable: true,
        arguments: { 'x-dead-letter-exchange': this.exchange },
      });
      for (const eventType of SUBSCRIBED_EVENTS) {
        await channel.bindQueue(this.queue, this.exchange, eventType);
      }
      await channel.prefetch(this.prefetch);
      if (this.stopping) {
        await channel.close();
        await connection.close();
        return;
      }
      this.connection = connection;
      this.channel = channel;
      this.reconnectAttempt = 0;
      connection.on('error', (e) =>
        this.logger.error(`Notification RabbitMQ connection error: ${this.safeError(e)}`),
      );
      connection.on('close', () => this.disconnected(connection));
      channel.on('error', (e) =>
        this.logger.error(`Notification RabbitMQ consumer channel error: ${this.safeError(e)}`),
      );
      channel.on('close', () => this.disconnected(connection));
      await channel.consume(this.queue, (msg) => {
        if (msg) void this.handleDelivery(channel, msg);
      });
      this.logger.log(
        JSON.stringify({
          event: 'notification.rabbitmq.consumer_started',
          exchange: this.exchange,
          queue: this.queue,
          routingKeys: [...SUBSCRIBED_EVENTS],
        }),
      );
    } catch (error) {
      await connection?.close().catch(() => undefined);
      this.logger.error(`Notification RabbitMQ consumer unavailable: ${this.safeError(error)}`);
      this.scheduleReconnect();
    }
  }

  private async handleDelivery(
    channel: amqp.Channel,
    message: amqp.ConsumeMessage,
  ): Promise<void> {
    let event: unknown;
    try {
      event = JSON.parse(message.content.toString('utf8')) as unknown;
      if (typeof event !== 'object' || event === null) {
        throw new PermanentNotificationEventError('Event payload is not an object');
      }
      const r = event as Record<string, unknown>;
      if (typeof r.eventType !== 'string') {
        throw new PermanentNotificationEventError('Event type is missing');
      }
      if (message.fields.routingKey !== r.eventType) {
        throw new PermanentNotificationEventError('Routing key does not match event type');
      }
      switch (r.eventType) {
        case ORDER_CONFIRMED_EVENT_TYPE:
          await this.orderConfirmed.consume(event);
          break;
        case ORDER_CANCELLED_EVENT_TYPE:
          await this.orderCancelled.consume(event);
          break;
        case PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE:
          await this.paymentFailed.consume(event);
          break;
        default:
          throw new PermanentNotificationEventError('Unsupported notification event type');
      }
      this.ack(channel, message);
    } catch (error) {
      if (this.isPermanent(error)) {
        this.logger.error(
          JSON.stringify({
            event: 'notification.rabbitmq.event_dead_lettered',
            eventType: this.field(event, 'eventType'),
            error: this.safeError(error),
          }),
        );
        this.nack(channel, message, false);
        return;
      }
      const retryCount = this.retryCount(message);
      if (retryCount >= this.maxRetries) {
        this.logger.error(
          JSON.stringify({
            event: 'notification.rabbitmq.event_retries_exhausted',
            eventType: this.field(event, 'eventType'),
            retries: retryCount,
            error: this.safeError(error),
          }),
        );
        this.nack(channel, message, false);
        return;
      }
      try {
        await this.publishRetry(message, retryCount + 1);
        this.ack(channel, message);
        this.logger.warn(
          JSON.stringify({
            event: 'notification.rabbitmq.event_retry_scheduled',
            eventType: this.field(event, 'eventType'),
            retry: retryCount + 1,
            error: this.safeError(error),
          }),
        );
      } catch (retryError) {
        this.logger.error(`Notification event retry publish failed: ${this.safeError(retryError)}`);
        this.nack(channel, message, true);
      }
    }
  }

  private async publishRetry(message: amqp.ConsumeMessage, retryCount: number): Promise<void> {
    const confirmChannel = this.publisherChannel.getConfirmChannel();
    const id = message.properties.messageId ?? `notification-${Date.now()}`;
    const backoff = Math.min(30_000, 1_000 * 2 ** (retryCount - 1));
    const delay = Math.floor(backoff * (0.5 + Math.random()));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Notification event retry publish confirmation timed out')),
        this.confirmTimeoutMs,
      );
      timeout.unref();
      try {
        confirmChannel.sendToQueue(
          this.retryQueue,
          message.content,
          {
            persistent: true,
            mandatory: true,
            expiration: String(delay),
            contentType: message.properties.contentType ?? 'application/json',
            messageId: id,
            type: message.properties.type ?? message.fields.routingKey,
            headers: {
              ...message.properties.headers,
              'x-notification-retry-count': retryCount,
            },
          },
          (error) => {
            clearTimeout(timeout);
            if (error) reject(error);
            else resolve();
          },
        );
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  private isPermanent(error: unknown): boolean {
    if (error instanceof PermanentNotificationEventError) return true;
    if (error instanceof SyntaxError) return true;
    return error instanceof HttpException && error.getStatus() < 500;
  }

  private retryCount(message: amqp.ConsumeMessage): number {
    const value = message.properties.headers?.['x-notification-retry-count'];
    const count = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }

  private ack(channel: amqp.Channel, message: amqp.ConsumeMessage): void {
    try { channel.ack(message); } catch (e: unknown) {
      this.logger.error(`Notification RabbitMQ ack failed: ${this.safeError(e)}`);
    }
  }

  private nack(channel: amqp.Channel, message: amqp.ConsumeMessage, requeue: boolean): void {
    try { channel.nack(message, false, requeue); } catch (e: unknown) {
      this.logger.error(`Notification RabbitMQ nack failed: ${this.safeError(e)}`);
    }
  }

  private field(value: unknown, key: string): string | null {
    if (typeof value !== 'object' || value === null) return null;
    const v = (value as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : null;
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

  private readPositiveInt(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid config: ${value}`);
    return n;
  }

  private safeError(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.replace(/amqps?:\/\/[^@\s]+@/gi, 'amqp://[redacted]@');
  }
}

class PermanentNotificationEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentNotificationEventError';
  }
}
