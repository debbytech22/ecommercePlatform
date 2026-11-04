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
  PAYMENT_AUTHORIZE_COMMAND_TYPE,
  PAYMENT_CAPTURE_COMMAND_TYPE,
  PAYMENT_REFUND_COMMAND_TYPE,
  PAYMENT_VOID_COMMAND_TYPE,
} from 'default/contracts';
import { PaymentAuthorizeConsumer } from '../consumers/payment-authorize.consumer';
import { PaymentCaptureConsumer } from '../consumers/payment-capture.consumer';
import { PaymentRefundConsumer } from '../consumers/payment-refund.consumer';
import { PaymentVoidConsumer } from '../consumers/payment-void.consumer';
import { RabbitMqPublisherChannel } from './rabbitmq-publisher-channel';

const commandTypes = new Set([
  PAYMENT_AUTHORIZE_COMMAND_TYPE,
  PAYMENT_CAPTURE_COMMAND_TYPE,
  PAYMENT_REFUND_COMMAND_TYPE,
  PAYMENT_VOID_COMMAND_TYPE,
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
    private readonly authorize: PaymentAuthorizeConsumer,
    private readonly capture: PaymentCaptureConsumer,
    private readonly voidPayment: PaymentVoidConsumer,
    private readonly refund: PaymentRefundConsumer,
    private readonly publisherChannel: RabbitMqPublisherChannel,
  ) {
    this.exchange = config.get<string>(
      'RABBITMQ_ORDERS_EXCHANGE',
      'ecommerce.events',
    );
    this.queue = config.get<string>(
      'PAYMENT_COMMAND_QUEUE',
      'payment.commands',
    );
    this.retryQueue = config.get<string>(
      'PAYMENT_COMMAND_RETRY_QUEUE',
      'payment.commands.retry',
    );
    this.deadLetterExchange = config.get<string>(
      'RABBITMQ_DEAD_LETTER_EXCHANGE',
      'ecommerce.events.dlx',
    );
    this.deadLetterQueue = config.get<string>(
      'PAYMENT_COMMAND_DEAD_LETTER_QUEUE',
      'payment.commands.dlq',
    );
    this.prefetch = this.readPositiveInteger(
      config.get<string>('PAYMENT_RABBITMQ_PREFETCH'),
      10,
      'PAYMENT_RABBITMQ_PREFETCH',
    );
    this.maxRetries = this.readPositiveInteger(
      config.get<string>('PAYMENT_COMMAND_MAX_RETRIES'),
      5,
      'PAYMENT_COMMAND_MAX_RETRIES',
    );
    this.confirmTimeoutMs = this.readPositiveInteger(
      config.get<string>('RABBITMQ_CONFIRM_TIMEOUT_MS'),
      10_000,
      'RABBITMQ_CONFIRM_TIMEOUT_MS',
    );
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
    await channel
      ?.close()
      .catch((error: unknown) =>
        this.logger.warn(
          `Failed closing Payment consumer channel: ${this.safeError(error)}`,
        ),
      );
    await connection
      ?.close()
      .catch((error: unknown) =>
        this.logger.warn(
          `Failed closing Payment consumer connection: ${this.safeError(error)}`,
        ),
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
    const url = this.configUrl();
    if (!url) {
      this.logger.error(
        'RABBITMQ_URL is missing; Payment command consumer is paused',
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
        'payment.invalid',
      );
      await channel.assertQueue(this.queue, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': this.deadLetterExchange,
          'x-dead-letter-routing-key': 'payment.invalid',
        },
      });
      await channel.assertQueue(this.retryQueue, {
        durable: true,
        arguments: { 'x-dead-letter-exchange': this.exchange },
      });
      for (const commandType of commandTypes) {
        await channel.bindQueue(this.queue, this.exchange, commandType);
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
      connection.on('error', (error) =>
        this.logger.error(
          `Payment RabbitMQ connection error: ${this.safeError(error)}`,
        ),
      );
      connection.on('close', () => this.disconnected(connection));
      channel.on('error', (error) =>
        this.logger.error(
          `Payment RabbitMQ consumer error: ${this.safeError(error)}`,
        ),
      );
      channel.on('close', () => this.disconnected(connection));
      await channel.consume(this.queue, (message) => {
        if (message) void this.handleDelivery(channel, message);
      });
      this.logger.log(
        JSON.stringify({
          event: 'payment.rabbitmq.consumer_started',
          exchange: this.exchange,
          queue: this.queue,
          routingKeys: [...commandTypes],
          deadLetterQueue: this.deadLetterQueue,
        }),
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
        `Payment RabbitMQ consumer unavailable: ${this.safeError(error)}`,
      );
      this.scheduleReconnect();
    }
  }

  private async handleDelivery(
    channel: amqp.Channel,
    message: amqp.ConsumeMessage,
  ): Promise<void> {
    const processingStartedAt = Date.now();
    let command: unknown;
    try {
      command = JSON.parse(message.content.toString('utf8')) as unknown;
      if (typeof command !== 'object' || command === null) {
        throw new PermanentPaymentCommandError(
          'Command payload is not an object',
        );
      }
      const record = command as Record<string, unknown>;
      if (typeof record.commandType !== 'string') {
        throw new PermanentPaymentCommandError('Command type is missing');
      }
      if (message.fields.routingKey !== record.commandType) {
        throw new PermanentPaymentCommandError(
          'RabbitMQ routing key does not match command type',
        );
      }
      switch (record.commandType) {
        case PAYMENT_AUTHORIZE_COMMAND_TYPE:
          await this.authorize.consume(command);
          break;
        case PAYMENT_CAPTURE_COMMAND_TYPE:
          await this.capture.consume(command);
          break;
        case PAYMENT_VOID_COMMAND_TYPE:
          await this.voidPayment.consume(command);
          break;
        case PAYMENT_REFUND_COMMAND_TYPE:
          await this.refund.consume(command);
          break;
        default:
          throw new PermanentPaymentCommandError('Unsupported payment command');
      }
      this.logger.log(
        JSON.stringify({
          event: 'payment.metric',
          metric: 'payment_consumer_processing_duration_ms',
          value: Date.now() - processingStartedAt,
          commandType: this.commandType(command),
          correlationId: this.correlationId(command),
          outcome: 'PROCESSED',
        }),
      );
      this.ack(channel, message);
      this.logger.log(
        JSON.stringify({
          event: 'payment.rabbitmq.command_acknowledged',
          commandId: this.commandId(command),
          commandType: this.commandType(command),
          correlationId: this.correlationId(command),
        }),
      );
    } catch (error) {
      this.logger.log(
        JSON.stringify({
          event: 'payment.metric',
          metric: 'payment_consumer_processing_duration_ms',
          value: Date.now() - processingStartedAt,
          commandType: this.commandType(command),
          correlationId: this.correlationId(command),
          outcome: this.isPermanent(error) ? 'REJECTED' : 'RETRY',
        }),
      );
      if (this.isPermanent(error)) {
        this.logger.error(
          JSON.stringify({
            event: 'payment.rabbitmq.command_dead_lettered',
            commandId: this.commandId(command),
            commandType: this.commandType(command),
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
            event: 'payment.rabbitmq.command_retries_exhausted',
            commandId: this.commandId(command),
            commandType: this.commandType(command),
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
            event: 'payment.rabbitmq.command_retry_scheduled',
            commandId: this.commandId(command),
            commandType: this.commandType(command),
            retry: retryCount + 1,
            error: this.safeError(error),
          }),
        );
      } catch (retryError) {
        this.logger.error(
          `Payment command retry publish failed: ${this.safeError(retryError)}`,
        );
        this.nack(channel, message, true);
      }
    }
  }

  private async publishRetry(
    message: amqp.ConsumeMessage,
    retryCount: number,
  ): Promise<void> {
    const confirmChannel = this.publisherChannel.getConfirmChannel();
    const id = message.properties.messageId ?? `payment-${Date.now()}`;
    const backoffDelay = Math.min(30_000, 1000 * 2 ** (retryCount - 1));
    const delay = Math.min(
      30_000,
      Math.floor(backoffDelay * (0.5 + Math.random())),
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error('Payment command retry publish confirmation timed out'),
          ),
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
              'x-payment-retry-count': retryCount,
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
    if (error instanceof PermanentPaymentCommandError) return true;
    if (error instanceof SyntaxError) return true;
    return error instanceof HttpException && error.getStatus() < 500;
  }

  private ack(channel: amqp.Channel, message: amqp.ConsumeMessage): void {
    try {
      channel.ack(message);
    } catch (error) {
      this.logger.error(
        `Payment RabbitMQ acknowledgement failed: ${this.safeError(error)}`,
      );
    }
  }

  private nack(
    channel: amqp.Channel,
    message: amqp.ConsumeMessage,
    requeue: boolean,
  ): void {
    try {
      channel.nack(message, false, requeue);
    } catch (error) {
      this.logger.error(
        `Payment RabbitMQ negative acknowledgement failed: ${this.safeError(error)}`,
      );
    }
  }

  private retryCount(message: amqp.ConsumeMessage): number {
    const value = message.properties.headers?.['x-payment-retry-count'];
    const count =
      typeof value === 'string'
        ? Number(value)
        : typeof value === 'number'
          ? value
          : 0;
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }

  private commandId(value: unknown): string | null {
    return this.field(value, 'commandId');
  }

  private commandType(value: unknown): string | null {
    return this.field(value, 'commandType');
  }

  private correlationId(value: unknown): string | null {
    return this.field(value, 'correlationId');
  }

  private field(value: unknown, key: string): string | null {
    if (typeof value !== 'object' || value === null || !(key in value)) {
      return null;
    }
    const field = (value as Record<string, unknown>)[key];
    return typeof field === 'string' ? field : null;
  }

  private configUrl(): string | undefined {
    return this.config.get<string>('RABBITMQ_URL');
  }

  private disconnected(connection: amqp.ChannelModel | undefined): void {
    if (!connection || this.connection !== connection || this.stopping) return;
    this.connection = undefined;
    this.channel = undefined;
    void connection
      .close()
      .catch((error: unknown) =>
        this.logger.warn(
          `Failed closing disconnected RabbitMQ connection: ${this.safeError(error)}`,
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

  private readPositiveInteger(
    configured: string | undefined,
    fallback: number,
    name: string,
  ): number {
    if (configured === undefined) return fallback;
    const value = Number(configured);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
  }

  private safeError(error: unknown): string {
    const value = error instanceof Error ? error.message : String(error);
    return value
      .replace(/amqps?:\/\/[^@\s]+@/gi, (url) =>
        url.startsWith('amqps:') ? 'amqps://[redacted]@' : 'amqp://[redacted]@',
      )
      .replace(/(password|secret|token)=([^&\s]+)/gi, '$1=[redacted]');
  }
}

class PermanentPaymentCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentPaymentCommandError';
  }
}
