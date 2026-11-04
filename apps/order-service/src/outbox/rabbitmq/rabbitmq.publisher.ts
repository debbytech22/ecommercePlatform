import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfirmChannel, Message } from 'amqplib';

import type {
  OutboxEvent,
  OutboxPublisher,
  VersionedCommandEnvelope,
  VersionedMessageEnvelope,
} from '../outbox-event.types';
import {
  INVENTORY_RELEASE_COMMAND_TYPE,
  PAYMENT_AUTHORIZE_COMMAND_TYPE,
  PAYMENT_CAPTURE_COMMAND_TYPE,
  PAYMENT_RECONCILE_COMMAND_TYPE,
  PAYMENT_REFUND_COMMAND_TYPE,
  PAYMENT_VOID_COMMAND_TYPE,
} from 'default/contracts';
import { RABBITMQ_CONNECTION, RabbitMqConnection } from './rabbitmq.connection';

const COMMAND_TYPES = new Set([
  INVENTORY_RELEASE_COMMAND_TYPE,
  PAYMENT_AUTHORIZE_COMMAND_TYPE,
  PAYMENT_CAPTURE_COMMAND_TYPE,
  PAYMENT_RECONCILE_COMMAND_TYPE,
  PAYMENT_REFUND_COMMAND_TYPE,
  PAYMENT_VOID_COMMAND_TYPE,
]);

@Injectable()
export class RabbitMqPublisher implements OutboxPublisher {
  private readonly confirmTimeoutMs: number;

  constructor(
    @Inject(RABBITMQ_CONNECTION)
    private readonly rabbitMq: RabbitMqConnection,
    private readonly config: ConfigService,
  ) {
    const configuredTimeout = this.config.get<string>(
      'RABBITMQ_CONFIRM_TIMEOUT_MS',
      '10000',
    );
    this.confirmTimeoutMs = Number(configuredTimeout);
    if (
      !Number.isSafeInteger(this.confirmTimeoutMs) ||
      this.confirmTimeoutMs < 1
    ) {
      throw new Error('RABBITMQ_CONFIRM_TIMEOUT_MS must be a positive integer');
    }
  }

  async publish(event: OutboxEvent): Promise<void> {
    const envelope = this.createEnvelope(event);
    const channel = this.rabbitMq.getConfirmChannel();
    const exchange = this.config.get<string>(
      'RABBITMQ_ORDERS_EXCHANGE',
      'ecommerce.events',
    );
    const messageId = 'commandId' in envelope ? envelope.commandId : event.id;
    const returnedMessages = new Map<string, string>();
    const onReturn = (message: Message): void => {
      const returnedMessageId = message.properties.messageId;
      if (returnedMessageId === messageId) {
        returnedMessages.set(
          messageId,
          `RabbitMQ did not route message ${messageId} with key ${message.fields.routingKey}`,
        );
      }
    };

    channel.on('return', onReturn);
    try {
      await this.publishWithConfirmation(
        channel,
        exchange,
        event,
        envelope,
        messageId,
      );
      const returnError = returnedMessages.get(messageId);
      if (returnError) {
        throw new Error(returnError);
      }
    } finally {
      channel.removeListener('return', onReturn);
    }
  }

  private publishWithConfirmation(
    channel: ConfirmChannel,
    exchange: string,
    event: OutboxEvent,
    envelope: VersionedMessageEnvelope,
    messageId: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(envelope), 'utf8');
      const timeout = setTimeout(() => {
        reject(
          new Error(`RabbitMQ confirmation timed out for event ${event.id}`),
        );
      }, this.confirmTimeoutMs);
      timeout.unref();

      try {
        channel.publish(
          exchange,
          event.eventType,
          body,
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            contentEncoding: 'utf-8',
            messageId,
            type: event.eventType,
            timestamp: Math.floor(Date.parse(envelope.occurredAt) / 1000),
            headers: {
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              eventId: event.id,
              eventVersion: envelope.eventVersion,
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

  private createEnvelope(event: OutboxEvent): VersionedMessageEnvelope {
    const occurredAt = event.payload.occurredAt;
    if (
      typeof occurredAt !== 'string' ||
      Number.isNaN(Date.parse(occurredAt))
    ) {
      throw new Error(
        `Outbox event ${event.id} has no valid occurredAt timestamp`,
      );
    }

    const data = { ...event.payload };
    if (COMMAND_TYPES.has(event.eventType)) {
      const commandId = data.commandId;
      const commandType = data.commandType;
      const aggregateId = data.aggregateId;
      const correlationId = data.correlationId;
      const causationId = data.causationId;
      const eventVersion = data.eventVersion;
      const commandPayload = data.payload;
      if (
        typeof commandId !== 'string' ||
        typeof commandType !== 'string' ||
        commandType !== event.eventType ||
        typeof aggregateId !== 'string' ||
        typeof correlationId !== 'string' ||
        typeof data.occurredAt !== 'string' ||
        Number.isNaN(Date.parse(data.occurredAt)) ||
        (causationId !== null && typeof causationId !== 'string') ||
        eventVersion !== 1 ||
        !this.isRecord(commandPayload)
      ) {
        throw new Error(
          `Outbox command ${event.id} has an invalid command envelope`,
        );
      }
      return {
        commandId,
        commandType,
        eventVersion,
        occurredAt,
        aggregateId,
        correlationId,
        causationId,
        payload: commandPayload,
      } satisfies VersionedCommandEnvelope;
    }

    delete data.eventId;
    delete data.eventType;
    delete data.eventVersion;
    delete data.aggregateId;
    delete data.occurredAt;
    delete data.correlationId;
    delete data.causationId;
    const correlationId =
      typeof event.payload.correlationId === 'string'
        ? event.payload.correlationId
        : event.id;
    const causationId =
      typeof event.payload.causationId === 'string'
        ? event.payload.causationId
        : null;
    return {
      eventId: event.id,
      eventType: event.eventType,
      eventVersion: 1,
      occurredAt,
      aggregateId: event.aggregateId,
      correlationId,
      causationId,
      payload: data,
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
