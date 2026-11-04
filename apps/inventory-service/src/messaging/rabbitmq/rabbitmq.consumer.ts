import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { QueryFailedError } from 'typeorm';

import {
  OrderCreatedConsumer,
  UnprocessableOrderEventError,
} from '../consumers/order-created.consumer';
import {
  InventoryReleaseConsumer,
  UnprocessableInventoryReleaseCommandError,
} from '../consumers/inventory-release.consumer';
import { InboxEventInProgressError } from '../../inbox/inbox.service';
import { InventoryMetricsService } from '../../observability/inventory-metrics.service';
import { RabbitMqPublisherChannel } from './rabbitmq.publisher-channel';

const DEFAULT_EXCHANGE = 'ecommerce.events';
const DEFAULT_QUEUE = 'inventory.order-created';
const DEFAULT_DEAD_LETTER_EXCHANGE = 'ecommerce.events.dlx';
const DEFAULT_DEAD_LETTER_QUEUE = 'inventory.order-created.dlq';
const DEFAULT_PREFETCH = 10;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 10000;
const ORDER_CREATED_ROUTING_KEY = 'order.created.v1';
const INVENTORY_RELEASE_ROUTING_KEY = 'inventory.release.v1';

@Injectable()
export class RabbitMqConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqConsumer.name);
  private readonly queue: string;
  private readonly exchange: string;
  private readonly deadLetterExchange: string;
  private readonly deadLetterQueue: string;
  private readonly prefetch: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly confirmTimeoutMs: number;
  private connection: amqp.ChannelModel | undefined;
  private channel: amqp.Channel | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connecting: Promise<void> | undefined;
  private stopping = false;
  private reconnectAttempt = 0;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    private readonly orderCreated: OrderCreatedConsumer,
    private readonly inventoryRelease: InventoryReleaseConsumer,
    private readonly publisherChannel: RabbitMqPublisherChannel,
    private readonly metrics: InventoryMetricsService,
  ) {
    this.exchange = this.config.get<string>(
      'RABBITMQ_ORDERS_EXCHANGE',
      DEFAULT_EXCHANGE,
    );
    this.queue = this.config.get<string>(
      'INVENTORY_ORDER_CREATED_QUEUE',
      DEFAULT_QUEUE,
    );
    this.deadLetterExchange = this.config.get<string>(
      'INVENTORY_DEAD_LETTER_EXCHANGE',
      DEFAULT_DEAD_LETTER_EXCHANGE,
    );
    this.deadLetterQueue = this.config.get<string>(
      'INVENTORY_DEAD_LETTER_QUEUE',
      DEFAULT_DEAD_LETTER_QUEUE,
    );
    this.prefetch = this.readPositiveInteger(
      'INVENTORY_RABBITMQ_PREFETCH',
      DEFAULT_PREFETCH,
    );
    this.maxRetries = this.readPositiveInteger(
      'INVENTORY_CONSUMER_MAX_RETRIES',
      DEFAULT_MAX_RETRIES,
    );
    this.retryBaseDelayMs = this.readPositiveInteger(
      'INVENTORY_CONSUMER_RETRY_BASE_DELAY_MS',
      DEFAULT_RETRY_BASE_DELAY_MS,
    );
    this.retryMaxDelayMs = this.readPositiveInteger(
      'INVENTORY_CONSUMER_RETRY_MAX_DELAY_MS',
      DEFAULT_RETRY_MAX_DELAY_MS,
    );
    this.confirmTimeoutMs = this.readPositiveInteger(
      'RABBITMQ_CONFIRM_TIMEOUT_MS',
      DEFAULT_CONFIRM_TIMEOUT_MS,
    );
    if (this.retryMaxDelayMs < this.retryBaseDelayMs) {
      throw new Error(
        'INVENTORY_CONSUMER_RETRY_MAX_DELAY_MS must be greater than or equal to INVENTORY_CONSUMER_RETRY_BASE_DELAY_MS',
      );
    }
  }

  onModuleInit(): void {
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const channel = this.channel;
    const connection = this.connection;
    this.channel = undefined;
    this.connection = undefined;
    this.metrics.setRabbitMqConnected('consumer', false);
    await channel?.close().catch((error: unknown) => {
      this.logger.warn(
        this.logRecord('inventory.rabbitmq.channel_close_failed', {
          error: this.errorMessage(error),
        }),
      );
    });
    await connection?.close().catch((error: unknown) => {
      this.logger.warn(
        this.logRecord('inventory.rabbitmq.connection_close_failed', {
          error: this.errorMessage(error),
        }),
      );
    });
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
        this.logRecord('inventory.rabbitmq.url_missing', {
          retrying: true,
        }),
      );
      this.scheduleReconnect();
      return;
    }

    let connection: amqp.ChannelModel | undefined;
    try {
      connection = await amqp.connect(url);
      const channel = await connection.createChannel();
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      await channel.assertExchange(this.deadLetterExchange, 'topic', {
        durable: true,
      });
      await channel.assertQueue(this.deadLetterQueue, { durable: true });
      await channel.bindQueue(
        this.deadLetterQueue,
        this.deadLetterExchange,
        'order.created.invalid',
      );
      await channel.assertQueue(this.queue, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': this.deadLetterExchange,
          'x-dead-letter-routing-key': 'order.created.invalid',
        },
      });
      await channel.assertQueue(
        this.retryQueueName(ORDER_CREATED_ROUTING_KEY),
        {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': this.exchange,
            'x-dead-letter-routing-key': ORDER_CREATED_ROUTING_KEY,
          },
        },
      );
      await channel.assertQueue(
        this.retryQueueName(INVENTORY_RELEASE_ROUTING_KEY),
        {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': this.exchange,
            'x-dead-letter-routing-key': INVENTORY_RELEASE_ROUTING_KEY,
          },
        },
      );
      await channel.bindQueue(
        this.queue,
        this.exchange,
        ORDER_CREATED_ROUTING_KEY,
      );
      await channel.bindQueue(
        this.queue,
        this.exchange,
        INVENTORY_RELEASE_ROUTING_KEY,
      );
      await channel.prefetch(this.prefetch);

      if (this.stopping) {
        await channel.close();
        await connection.close();
        return;
      }

      this.connection = connection;
      this.channel = channel;
      this.reconnectAttempt = 0;
      this.metrics.setRabbitMqConnected('consumer', true);

      connection.on('error', (error) => {
        this.logger.error(
          this.logRecord('inventory.rabbitmq.connection_error', {
            error: this.errorMessage(error),
          }),
        );
      });
      connection.on('close', () => this.handleDisconnect(connection));
      channel.on('error', (error) => {
        this.logger.error(
          this.logRecord('inventory.rabbitmq.channel_error', {
            error: this.errorMessage(error),
          }),
        );
      });
      channel.on('close', () => this.handleDisconnect(connection));

      await channel.consume(this.queue, (message) => {
        if (message) {
          void this.handleDelivery(channel, message);
        }
      });
      this.logger.log(
        this.logRecord('inventory.rabbitmq.consumer_started', {
          exchange: this.exchange,
          queue: this.queue,
          routingKeys: [
            ORDER_CREATED_ROUTING_KEY,
            INVENTORY_RELEASE_ROUTING_KEY,
          ],
          deadLetterQueue: this.deadLetterQueue,
        }),
      );
    } catch (error) {
      if (this.connection === connection) {
        this.connection = undefined;
        this.channel = undefined;
      }
      await connection?.close().catch((closeError: unknown) => {
        this.logger.warn(
          this.logRecord('inventory.rabbitmq.failed_connection_close', {
            error: this.errorMessage(closeError),
          }),
        );
      });
      this.logger.error(
        this.logRecord('inventory.rabbitmq.connection_failed', {
          error: this.errorMessage(error),
        }),
      );
      this.metrics.setRabbitMqConnected('consumer', false);
      this.scheduleReconnect();
    }
  }

  private async handleDelivery(
    channel: amqp.Channel,
    message: amqp.ConsumeMessage,
  ): Promise<void> {
    let event: unknown;
    try {
      event = JSON.parse(message.content.toString('utf8'));
      const result =
        message.fields.routingKey === INVENTORY_RELEASE_ROUTING_KEY
          ? await this.inventoryRelease.consume(event)
          : await this.orderCreated.consume(event);
      channel.ack(message);
      this.logger.log(
        this.logRecord('inventory.rabbitmq.delivery_acknowledged', {
          eventId:
            typeof event === 'object' &&
            event !== null &&
            'eventId' in event &&
            typeof event.eventId === 'string'
              ? event.eventId
              : message.properties.messageId,
          ...this.eventMetadata(event),
          result,
        }),
      );
    } catch (error) {
      const retryCount = this.readRetryCount(message);
      if (this.isPermanentFailure(error)) {
        this.rejectToDeadLetter(channel, message, error, event);
        return;
      }
      if (!this.isRetryableFailure(error)) {
        this.rejectToDeadLetter(channel, message, error, event);
        return;
      }
      if (retryCount >= this.maxRetries) {
        this.logger.error(
          this.logRecord('inventory.rabbitmq.retry_exhausted', {
            messageId: message.properties.messageId ?? null,
            retries: retryCount,
            ...this.eventMetadata(event),
            error: this.errorMessage(error),
          }),
        );
        this.rejectToDeadLetter(channel, message, error, event);
        return;
      }

      this.logger.error(
        this.logRecord('inventory.rabbitmq.delivery_retrying', {
          messageId: message.properties.messageId ?? null,
          routingKey: message.fields.routingKey,
          retry: retryCount + 1,
          ...this.eventMetadata(event),
          error: this.errorMessage(error),
        }),
      );
      try {
        await this.publishRetry(message, retryCount + 1);
        this.metrics.recordConsumerOutcome('retried');
        channel.ack(message);
      } catch (retryError) {
        this.logger.error(
          this.logRecord('inventory.rabbitmq.retry_publish_failed', {
            messageId: message.properties.messageId ?? null,
            error: this.errorMessage(retryError),
          }),
        );
        try {
          channel.nack(message, false, true);
        } catch (nackError) {
          this.logger.error(
            this.logRecord('inventory.rabbitmq.delivery_nack_failed', {
              messageId: message.properties.messageId ?? null,
              error: this.errorMessage(nackError),
            }),
          );
        }
      }
    }
  }

  private rejectToDeadLetter(
    channel: amqp.Channel,
    message: amqp.ConsumeMessage,
    error: unknown,
    event?: unknown,
  ): void {
    this.logger.error(
      this.logRecord('inventory.rabbitmq.delivery_rejected', {
        messageId: message.properties.messageId ?? null,
        routingKey: message.fields.routingKey,
        ...this.eventMetadata(event),
        error: this.errorMessage(error),
      }),
    );
    this.metrics.recordConsumerOutcome('dead_lettered');
    try {
      channel.nack(message, false, false);
    } catch (nackError) {
      this.logger.error(
        this.logRecord('inventory.rabbitmq.delivery_nack_failed', {
          messageId: message.properties.messageId ?? null,
          error: this.errorMessage(nackError),
        }),
      );
    }
  }

  private eventMetadata(event: unknown): {
    correlationId: string | null;
    causationId: string | null;
  } {
    if (typeof event !== 'object' || event === null) {
      return { correlationId: null, causationId: null };
    }
    const record = event as Record<string, unknown>;
    return {
      correlationId:
        typeof record.correlationId === 'string' ? record.correlationId : null,
      causationId:
        typeof record.causationId === 'string' ? record.causationId : null,
    };
  }

  private async publishRetry(
    message: amqp.ConsumeMessage,
    retryCount: number,
  ): Promise<void> {
    const channel = this.publisherChannel.getConfirmChannel();
    const messageId = message.properties.messageId ?? `inventory-${Date.now()}`;
    const returned = new Set<string>();
    const onReturn = (returnedMessage: amqp.Message): void => {
      if (returnedMessage.properties.messageId === messageId) {
        returned.add(messageId);
      }
    };
    channel.on('return', onReturn);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(`Retry publish confirmation timed out for ${messageId}`),
          );
        }, this.confirmTimeoutMs);
        timeout.unref();
        try {
          channel.sendToQueue(
            this.retryQueueName(message.fields.routingKey),
            message.content,
            {
              persistent: true,
              mandatory: true,
              contentType: message.properties.contentType,
              contentEncoding: message.properties.contentEncoding,
              messageId,
              type: message.properties.type,
              correlationId: message.properties.correlationId,
              timestamp: message.properties.timestamp,
              expiration: String(this.retryDelay(retryCount)),
              headers: {
                ...message.properties.headers,
                'x-inventory-retry-count': retryCount,
              },
            },
            (error) => {
              clearTimeout(timeout);
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            },
          );
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
      if (returned.has(messageId)) {
        throw new Error(`RabbitMQ did not route retry message ${messageId}`);
      }
    } finally {
      channel.removeListener('return', onReturn);
    }
  }

  private retryQueueName(routingKey: string): string {
    return routingKey === ORDER_CREATED_ROUTING_KEY
      ? `${this.queue}.retry`
      : `${this.queue}.retry.${routingKey.replaceAll('.', '-')}`;
  }

  private retryDelay(retryCount: number): number {
    const exponentialDelay = Math.min(
      this.retryBaseDelayMs * 2 ** Math.min(retryCount - 1, 20),
      this.retryMaxDelayMs,
    );
    return Math.min(
      this.retryMaxDelayMs,
      Math.floor(exponentialDelay * (0.5 + Math.random())),
    );
  }

  private readRetryCount(message: amqp.ConsumeMessage): number {
    const value = message.properties.headers?.['x-inventory-retry-count'];
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : 0;
  }

  private isPermanentFailure(error: unknown): boolean {
    return (
      error instanceof UnprocessableOrderEventError ||
      error instanceof UnprocessableInventoryReleaseCommandError ||
      error instanceof SyntaxError ||
      (error instanceof HttpException && error.getStatus() < 500)
    );
  }

  private isRetryableFailure(error: unknown): boolean {
    if (error instanceof InboxEventInProgressError) {
      return true;
    }
    if (error instanceof QueryFailedError) {
      return true;
    }
    const code = this.driverErrorCode(error);
    return (
      code === 'ER_LOCK_DEADLOCK' ||
      code === 'ER_LOCK_WAIT_TIMEOUT' ||
      code === 'PROTOCOL_CONNECTION_LOST' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'EPIPE' ||
      code === 'ER_SERVER_SHUTDOWN'
    );
  }

  private driverErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) {
      return undefined;
    }
    if ('code' in error && typeof error.code === 'string') {
      return error.code;
    }
    if ('driverError' in error) {
      const driverError: unknown = error.driverError;
      if (
        typeof driverError === 'object' &&
        driverError !== null &&
        'code' in driverError &&
        typeof driverError.code === 'string'
      ) {
        return driverError.code;
      }
    }
    return undefined;
  }

  private handleDisconnect(connection: amqp.ChannelModel | undefined): void {
    if (!connection || this.connection !== connection || this.stopping) {
      return;
    }
    this.connection = undefined;
    this.channel = undefined;
    this.metrics.setRabbitMqConnected('consumer', false);
    this.logger.warn(
      this.logRecord('inventory.rabbitmq.disconnected', {
        retrying: true,
      }),
    );
    void connection.close().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) {
      return;
    }
    const baseDelay = this.readPositiveInteger(
      'RABBITMQ_RECONNECT_BASE_DELAY_MS',
      1000,
    );
    const maxDelay = this.readPositiveInteger(
      'RABBITMQ_RECONNECT_MAX_DELAY_MS',
      30000,
    );
    if (maxDelay < baseDelay) {
      this.logger.error(
        this.logRecord('inventory.rabbitmq.invalid_reconnect_config', {
          baseDelay,
          maxDelay,
        }),
      );
      return;
    }
    const exponentialDelay = Math.min(
      baseDelay * 2 ** Math.min(this.reconnectAttempt, 30),
      maxDelay,
    );
    const delay = Math.min(
      maxDelay,
      Math.floor(exponentialDelay * (0.5 + Math.random())),
    );
    this.reconnectAttempt += 1;
    this.metrics.recordRabbitMqReconnect('consumer');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
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

  private logRecord(event: string, fields: Record<string, unknown>): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      component: 'inventory-rabbitmq-consumer',
      event,
      ...fields,
    });
  }

  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/amqps?:\/\/[^@\s]+@/gi, (url) => {
      const protocol = url.startsWith('amqps:') ? 'amqps' : 'amqp';
      return `${protocol}://[redacted]@`;
    });
  }
}
