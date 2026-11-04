import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import {
  INVENTORY_RELEASED_EVENT_TYPE,
  INVENTORY_RELEASE_FAILED_EVENT_TYPE,
  INVENTORY_RESERVATION_FAILED_EVENT_TYPE,
  INVENTORY_RESERVED_EVENT_TYPE,
  PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE,
  PAYMENT_AUTHORIZATION_UNCERTAIN_EVENT_TYPE,
  PAYMENT_AUTHORIZED_EVENT_TYPE,
  PAYMENT_RECONCILED_EVENT_TYPE,
  PAYMENT_REFUND_FAILED_EVENT_TYPE,
  PAYMENT_REFUNDED_EVENT_TYPE,
  PAYMENT_VOID_FAILED_EVENT_TYPE,
  PAYMENT_VOIDED_EVENT_TYPE,
} from 'default/contracts';
import { isRecord } from './event-validation';
import { InventoryReleaseResultConsumer } from './inventory-release-result.consumer';
import { InventoryResultConsumer } from './inventory-result.consumer';
import { PaymentResultConsumer } from './payment-result.consumer';
import { PaymentCompensationResultConsumer } from './payment-compensation-result.consumer';
import { UnprocessableSagaEventError } from './unprocessable-saga-event.error';

const DEFAULT_RETRY_COUNT = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30000;

@Injectable()
export class SagaRabbitMqConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SagaRabbitMqConsumer.name);
  private readonly queue: string;
  private readonly exchange: string;
  private readonly deadLetterExchange: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly prefetch: number;
  private connection: amqp.ChannelModel | undefined;
  private channel: amqp.ConfirmChannel | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connecting: Promise<void> | undefined;
  private reconnectAttempt = 0;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly inventory: InventoryResultConsumer,
    private readonly payments: PaymentResultConsumer,
    private readonly compensation: InventoryReleaseResultConsumer,
    private readonly paymentCompensation: PaymentCompensationResultConsumer,
  ) {
    this.queue = this.config.get<string>(
      'ORDER_SAGA_RESULTS_QUEUE',
      'order.saga-results',
    );
    this.exchange = this.config.get<string>(
      'RABBITMQ_ORDERS_EXCHANGE',
      'ecommerce.events',
    );
    this.deadLetterExchange = this.config.get<string>(
      'ORDER_SAGA_DEAD_LETTER_EXCHANGE',
      'order.saga.dead-letter',
    );
    this.maxRetries = this.readPositiveInteger(
      'ORDER_SAGA_CONSUMER_MAX_RETRIES',
      DEFAULT_RETRY_COUNT,
      true,
    );
    this.retryBaseDelayMs = this.readPositiveInteger(
      'ORDER_SAGA_CONSUMER_RETRY_BASE_DELAY_MS',
      DEFAULT_RETRY_BASE_DELAY_MS,
    );
    this.retryMaxDelayMs = this.readPositiveInteger(
      'ORDER_SAGA_CONSUMER_RETRY_MAX_DELAY_MS',
      DEFAULT_RETRY_MAX_DELAY_MS,
    );
    this.prefetch = this.readPositiveInteger('ORDER_SAGA_PREFETCH', 10);
    if (this.retryMaxDelayMs < this.retryBaseDelayMs) {
      throw new Error(
        'ORDER_SAGA_CONSUMER_RETRY_MAX_DELAY_MS must be greater than or equal to ORDER_SAGA_CONSUMER_RETRY_BASE_DELAY_MS',
      );
    }
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
    await channel?.close().catch((error: unknown) => {
      this.log('order.saga.consumer.channel_close_failed', error);
    });
    await connection?.close().catch((error: unknown) => {
      this.log('order.saga.consumer.connection_close_failed', error);
    });
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
      this.logger.error(
        'RABBITMQ_URL is not configured; Saga result consumption is paused',
      );
      this.scheduleReconnect();
      return;
    }

    let connection: amqp.ChannelModel | undefined;
    try {
      const parsed = this.validateUrl(url);
      connection = await amqp.connect(url, this.getTlsOptions(parsed));
      const channel = await connection.createConfirmChannel();
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      await channel.assertExchange(this.deadLetterExchange, 'topic', {
        durable: true,
      });
      const deadLetterQueue = `${this.queue}.dead-letter`;
      await channel.assertQueue(deadLetterQueue, { durable: true });
      await channel.bindQueue(deadLetterQueue, this.deadLetterExchange, '#');
      await channel.assertQueue(this.queue, {
        durable: true,
        arguments: { 'x-dead-letter-exchange': this.deadLetterExchange },
      });
      for (const eventType of this.resultEventTypes()) {
        await channel.bindQueue(this.queue, this.exchange, eventType);
      }
      await channel.prefetch(this.prefetch);
      await channel.consume(
        this.queue,
        (message) => {
          if (message) void this.handleDelivery(channel, message);
        },
        { noAck: false },
      );

      if (this.stopping) {
        await channel.close();
        await connection.close();
        return;
      }
      this.connection = connection;
      this.channel = channel;
      this.reconnectAttempt = 0;
      connection.on('error', (error) =>
        this.log('order.saga.consumer.connection_error', error),
      );
      connection.on('close', () => this.handleDisconnect(connection));
      channel.on('error', (error) =>
        this.log('order.saga.consumer.channel_error', error),
      );
      channel.on('close', () => this.handleDisconnect(connection));
      this.logger.log(
        JSON.stringify({
          event: 'order.saga.consumer.connected',
          queue: this.queue,
          exchange: this.exchange,
        }),
      );
    } catch (error) {
      await connection?.close().catch((closeError: unknown) => {
        this.log('order.saga.consumer.setup_close_failed', closeError);
      });
      this.log('order.saga.consumer.connection_failed', error);
      this.scheduleReconnect();
    }
  }

  private async handleDelivery(
    channel: amqp.ConfirmChannel,
    message: amqp.ConsumeMessage,
  ): Promise<void> {
    let event: unknown;
    try {
      event = JSON.parse(message.content.toString('utf8')) as unknown;
    } catch (error) {
      this.log('order.saga.consumer.invalid_json', error);
      channel.nack(message, false, false);
      return;
    }

    try {
      await this.dispatch(event);
      channel.ack(message);
    } catch (error) {
      this.log('order.saga.consumer.processing_failed', error);
      if (error instanceof UnprocessableSagaEventError) {
        channel.nack(message, false, false);
        return;
      }

      let retryCount: number;
      try {
        retryCount = this.readRetryCount(message);
      } catch (retryCountError) {
        this.log('order.saga.consumer.invalid_retry_counter', retryCountError);
        channel.nack(message, false, false);
        return;
      }
      if (retryCount >= this.maxRetries) {
        this.logger.error(
          JSON.stringify({
            event: 'order.saga.consumer.retry_exhausted',
            messageId: message.properties.messageId ?? null,
            retryCount,
            maxRetries: this.maxRetries,
          }),
        );
        channel.nack(message, false, false);
        return;
      }
      try {
        await this.publishRetry(channel, message, retryCount + 1);
        channel.ack(message);
      } catch (publishError) {
        this.log('order.saga.consumer.retry_publish_failed', publishError);
        channel.nack(message, false, true);
      }
    }
  }

  private async dispatch(event: unknown): Promise<void> {
    if (!isRecord(event) || typeof event.eventType !== 'string') {
      throw new UnprocessableSagaEventError(
        'Saga result event has no eventType',
      );
    }
    switch (event.eventType) {
      case INVENTORY_RESERVED_EVENT_TYPE:
      case INVENTORY_RESERVATION_FAILED_EVENT_TYPE:
        await this.inventory.consume(event);
        return;
      case PAYMENT_AUTHORIZED_EVENT_TYPE:
      case PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE:
      case PAYMENT_AUTHORIZATION_UNCERTAIN_EVENT_TYPE:
      case PAYMENT_RECONCILED_EVENT_TYPE:
        await this.payments.consume(event);
        return;
      case PAYMENT_REFUNDED_EVENT_TYPE:
      case PAYMENT_REFUND_FAILED_EVENT_TYPE:
      case PAYMENT_VOIDED_EVENT_TYPE:
      case PAYMENT_VOID_FAILED_EVENT_TYPE:
        await this.paymentCompensation.consume(event);
        return;
      case INVENTORY_RELEASED_EVENT_TYPE:
      case INVENTORY_RELEASE_FAILED_EVENT_TYPE:
        await this.compensation.consume(event);
        return;
      default:
        throw new UnprocessableSagaEventError(
          `Unsupported Saga result type ${event.eventType}`,
        );
    }
  }

  private async publishRetry(
    channel: amqp.ConfirmChannel,
    message: amqp.ConsumeMessage,
    retryCount: number,
  ): Promise<void> {
    const retryQueue = `${this.queue}.retry.${retryCount}`;
    const backoffDelay = Math.min(
      this.retryBaseDelayMs * 2 ** (retryCount - 1),
      this.retryMaxDelayMs,
    );
    const delay = Math.min(
      this.retryMaxDelayMs,
      Math.floor(backoffDelay * (0.5 + Math.random())),
    );
    await channel.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        'x-message-ttl': delay,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': this.queue,
      },
    });
    await new Promise<void>((resolve, reject) => {
      channel.sendToQueue(
        retryQueue,
        message.content,
        {
          persistent: true,
          contentType: message.properties.contentType ?? 'application/json',
          contentEncoding: message.properties.contentEncoding ?? 'utf-8',
          messageId: message.properties.messageId,
          type: message.properties.type,
          headers: {
            ...message.properties.headers,
            'x-order-saga-retry': retryCount,
          },
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  private readRetryCount(message: amqp.ConsumeMessage): number {
    const count = message.properties.headers?.['x-order-saga-retry'] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new UnprocessableSagaEventError(
        'Saga message has an invalid retry counter',
      );
    }
    return count as number;
  }

  private resultEventTypes(): readonly string[] {
    return [
      INVENTORY_RESERVED_EVENT_TYPE,
      INVENTORY_RESERVATION_FAILED_EVENT_TYPE,
      PAYMENT_AUTHORIZED_EVENT_TYPE,
      PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE,
      PAYMENT_AUTHORIZATION_UNCERTAIN_EVENT_TYPE,
      PAYMENT_REFUNDED_EVENT_TYPE,
      PAYMENT_REFUND_FAILED_EVENT_TYPE,
      PAYMENT_VOIDED_EVENT_TYPE,
      PAYMENT_VOID_FAILED_EVENT_TYPE,
      PAYMENT_RECONCILED_EVENT_TYPE,
      INVENTORY_RELEASED_EVENT_TYPE,
      INVENTORY_RELEASE_FAILED_EVENT_TYPE,
    ];
  }

  private handleDisconnect(connection: amqp.ChannelModel | undefined): void {
    if (!connection || this.connection !== connection || this.stopping) return;
    this.connection = undefined;
    this.channel = undefined;
    void connection.close().catch((error: unknown) => {
      this.log('order.saga.consumer.disconnect_close_failed', error);
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const baseDelay = 1000;
    const maxDelay = 30000;
    const exponential = Math.min(
      baseDelay * 2 ** Math.min(this.reconnectAttempt, 30),
      maxDelay,
    );
    const delay = Math.floor(exponential * (0.5 + Math.random()));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private validateUrl(value: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('RABBITMQ_URL must be a valid AMQP URL');
    }
    if (
      (parsed.protocol !== 'amqp:' && parsed.protocol !== 'amqps:') ||
      !parsed.hostname ||
      !parsed.username ||
      !parsed.password
    ) {
      throw new Error(
        'RABBITMQ_URL must use AMQP(S) and include host credentials',
      );
    }
    if (
      this.config.get<string>('RABBITMQ_TLS_REQUIRED') === 'true' &&
      parsed.protocol !== 'amqps:'
    ) {
      throw new Error('RABBITMQ_TLS_REQUIRED requires an amqps URL');
    }
    return parsed;
  }

  private getTlsOptions(parsed: URL): import('node:tls').ConnectionOptions {
    if (parsed.protocol !== 'amqps:') return {};
    const ca = this.config.get<string>('RABBITMQ_TLS_CA');
    const servername = this.config.get<string>('RABBITMQ_TLS_SERVER_NAME');
    return {
      rejectUnauthorized: true,
      ...(ca ? { ca: [ca.replace(/\\n/g, '\n')] } : {}),
      ...(servername ? { servername } : {}),
    };
  }

  private readPositiveInteger(
    name: string,
    defaultValue: number,
    allowZero = false,
  ): number {
    const configured = this.config.get<string>(name);
    if (configured === undefined) return defaultValue;
    const value = Number(configured);
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new Error(
        `${name} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`,
      );
    }
    return value;
  }

  private log(event: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(
      JSON.stringify({
        event,
        error: message.replace(/(amqps?):\/\/[^@\s]+@/gi, '$1://[redacted]@'),
      }),
    );
  }
}
