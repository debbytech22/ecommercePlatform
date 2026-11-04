import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfirmChannel } from 'amqplib';
import { RabbitMqPublisherChannel } from '../rabbitmq/rabbitmq-publisher-channel';

@Injectable()
export class NotificationEventPublisher {
  private readonly logger = new Logger(NotificationEventPublisher.name);
  private readonly exchange: string;
  private readonly confirmTimeoutMs: number;

  constructor(
    private readonly connection: RabbitMqPublisherChannel,
    config: ConfigService,
  ) {
    this.exchange = config.get<string>('RABBITMQ_EVENTS_EXCHANGE', 'ecommerce.events');
    this.confirmTimeoutMs = Number(config.get<string>('RABBITMQ_CONFIRM_TIMEOUT_MS') ?? '10000');
  }

  async publish(payload: Record<string, unknown>): Promise<void> {
    const eventId = String(payload.eventId ?? '');
    const eventType = String(payload.eventType ?? '');
    const occurredAt = String(payload.occurredAt ?? new Date().toISOString());
    const correlationId = String(payload.correlationId ?? '');
    if (!eventId || !eventType) {
      throw new Error('Notification outbox event has an invalid envelope');
    }
    const channel = this.connection.getConfirmChannel();
    await this.publishConfirmed(channel, eventId, eventType, occurredAt, correlationId, payload);
  }

  private publishConfirmed(
    channel: ConfirmChannel,
    eventId: string,
    eventType: string,
    occurredAt: string,
    correlationId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`RabbitMQ confirmation timed out for notification event ${eventId}`)),
        this.confirmTimeoutMs,
      );
      timeout.unref();
      try {
        channel.publish(
          this.exchange,
          eventType,
          Buffer.from(JSON.stringify(payload), 'utf8'),
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            contentEncoding: 'utf-8',
            messageId: eventId,
            type: eventType,
            timestamp: Math.floor(Date.parse(occurredAt) / 1000),
            headers: { correlationId },
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
}
