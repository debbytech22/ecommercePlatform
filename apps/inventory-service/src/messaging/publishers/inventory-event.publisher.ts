import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfirmChannel, Message } from 'amqplib';

import type { InventoryEvent } from 'default/contracts';
import {
  INVENTORY_RESERVATION_FAILED_EVENT_TYPE,
  INVENTORY_RESERVED_EVENT_TYPE,
} from 'default/contracts';
import { RabbitMqPublisherChannel } from '../rabbitmq/rabbitmq.publisher-channel';

@Injectable()
export class InventoryEventPublisher {
  private readonly exchange: string;
  private readonly confirmTimeoutMs: number;

  constructor(
    @Inject(RabbitMqPublisherChannel)
    private readonly connection: RabbitMqPublisherChannel,
    config: ConfigService,
  ) {
    this.exchange = config.get<string>(
      'RABBITMQ_ORDERS_EXCHANGE',
      'ecommerce.events',
    );
    this.confirmTimeoutMs = this.readPositiveInteger(
      config.get<string>('RABBITMQ_CONFIRM_TIMEOUT_MS'),
      10_000,
      'RABBITMQ_CONFIRM_TIMEOUT_MS',
    );
  }

  async publish(event: InventoryEvent): Promise<void> {
    this.validateEnvelope(event);
    const channel = this.connection.getConfirmChannel();
    const returned = new Set<string>();
    const onReturn = (message: Message): void => {
      if (message.properties.messageId === event.eventId) {
        returned.add(event.eventId);
      }
    };

    channel.on('return', onReturn);
    try {
      await this.publishConfirmed(channel, event);
      if (returned.has(event.eventId)) {
        throw new Error(
          `RabbitMQ did not route inventory event ${event.eventId}`,
        );
      }
    } finally {
      channel.removeListener('return', onReturn);
    }
  }

  private publishConfirmed(
    channel: ConfirmChannel,
    event: InventoryEvent,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(event), 'utf8');
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `RabbitMQ confirmation timed out for inventory event ${event.eventId}`,
          ),
        );
      }, this.confirmTimeoutMs);
      timeout.unref();

      try {
        channel.publish(
          this.exchange,
          event.eventType,
          body,
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
  }

  private readPositiveInteger(
    configured: string | undefined,
    defaultValue: number,
    name: string,
  ): number {
    if (configured === undefined) {
      return defaultValue;
    }
    const value = Number(configured);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
  }

  private validateEnvelope(event: unknown): asserts event is InventoryEvent {
    if (typeof event !== 'object' || event === null) {
      throw new Error('Inventory outbox event has an invalid envelope');
    }
    const candidate = event as Record<string, unknown>;
    if (
      typeof candidate.eventId !== 'string' ||
      !candidate.eventId ||
      (candidate.eventType !== INVENTORY_RESERVED_EVENT_TYPE &&
        candidate.eventType !== INVENTORY_RESERVATION_FAILED_EVENT_TYPE) ||
      candidate.eventVersion !== 1 ||
      typeof candidate.aggregateId !== 'string' ||
      typeof candidate.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(candidate.occurredAt)) ||
      typeof candidate.correlationId !== 'string' ||
      !candidate.correlationId ||
      (candidate.causationId !== null &&
        typeof candidate.causationId !== 'string') ||
      typeof candidate.payload !== 'object' ||
      candidate.payload === null
    ) {
      throw new Error('Inventory outbox event has an invalid envelope');
    }
  }
}
