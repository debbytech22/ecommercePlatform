import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfirmChannel, Message } from 'amqplib';
import { RabbitMqPublisherChannel } from '../rabbitmq/rabbitmq-publisher-channel';

interface PaymentEventEnvelope {
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateId: string;
  occurredAt: string;
  correlationId: string;
  causationId: string | null;
}

@Injectable()
export class PaymentEventPublisher {
  private readonly exchange: string;
  private readonly confirmationTimeoutMs: number;

  constructor(
    private readonly connection: RabbitMqPublisherChannel,
    config: ConfigService,
  ) {
    this.exchange = config.get<string>(
      'RABBITMQ_ORDERS_EXCHANGE',
      'ecommerce.events',
    );
    this.confirmationTimeoutMs = this.readPositiveInteger(
      config.get<string>('RABBITMQ_CONFIRM_TIMEOUT_MS'),
      10_000,
    );
  }

  async publish(value: Record<string, unknown>): Promise<void> {
    this.validateEnvelope(value);
    const event = value;
    const channel = this.connection.getConfirmChannel();
    const returned = new Set<string>();
    const onReturn = (message: Message): void => {
      if (message.properties.messageId === event.eventId) {
        returned.add(event.eventId);
      }
    };
    channel.on('return', onReturn);
    try {
      await this.publishConfirmed(channel, event, value);
      if (returned.has(event.eventId)) {
        throw new Error(
          `RabbitMQ did not route payment event ${event.eventId}`,
        );
      }
    } finally {
      channel.removeListener('return', onReturn);
    }
  }

  private publishConfirmed(
    channel: ConfirmChannel,
    event: PaymentEventEnvelope,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `RabbitMQ confirmation timed out for payment event ${event.eventId}`,
          ),
        );
      }, this.confirmationTimeoutMs);
      timeout.unref();
      try {
        channel.publish(
          this.exchange,
          event.eventType,
          Buffer.from(JSON.stringify(payload), 'utf8'),
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            contentEncoding: 'utf-8',
            messageId: event.eventId,
            type: event.eventType,
            timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
            headers: {
              eventVersion: event.eventVersion,
              aggregateId: event.aggregateId,
              correlationId: event.correlationId,
              causationId: event.causationId,
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

  private validateEnvelope(
    value: Record<string, unknown>,
  ): asserts value is Record<string, unknown> &
    PaymentEventEnvelope & { payload: Record<string, unknown> } {
    if (
      typeof value.eventId !== 'string' ||
      value.eventId.trim().length === 0 ||
      value.eventId.length > 36 ||
      typeof value.eventType !== 'string' ||
      value.eventType.trim().length === 0 ||
      value.eventVersion !== 1 ||
      typeof value.aggregateId !== 'string' ||
      typeof value.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(value.occurredAt)) ||
      typeof value.correlationId !== 'string' ||
      (value.causationId !== null && typeof value.causationId !== 'string') ||
      typeof value.payload !== 'object' ||
      value.payload === null ||
      Array.isArray(value.payload)
    ) {
      throw new Error('Payment outbox event has an invalid envelope');
    }
  }

  private readPositiveInteger(
    configured: string | undefined,
    fallback: number,
  ): number {
    if (configured === undefined) return fallback;
    const value = Number(configured);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('RABBITMQ_CONFIRM_TIMEOUT_MS must be positive');
    }
    return value;
  }
}
