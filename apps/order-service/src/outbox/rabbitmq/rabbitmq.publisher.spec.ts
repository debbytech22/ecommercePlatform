import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import type { ConfirmChannel, Message } from 'amqplib';

import type { OutboxEvent } from '../outbox-event.types';
import { RabbitMqConnection } from './rabbitmq.connection';
import { RabbitMqPublisher } from './rabbitmq.publisher';

describe('RabbitMqPublisher', () => {
  const event: OutboxEvent = {
    id: 'event-1',
    aggregateType: 'Order',
    aggregateId: 'order-1',
    eventType: 'order.created.v1',
    payload: {
      eventId: 'event-1',
      eventType: 'order.created.v1',
      occurredAt: '2026-10-31T00:00:00.000Z',
      orderId: 'order-1',
    },
    attempts: 0,
  };

  it('publishes a persistent message and resolves after publisher confirmation', async () => {
    const channel = new EventEmitter() as EventEmitter & {
      publish: jest.Mock;
    };
    channel.publish = jest.fn(
      (
        _exchange: string,
        _routingKey: string,
        _body: Buffer,
        _options: Record<string, unknown>,
        confirm: (error?: Error | null) => void,
      ) => {
        confirm();
        return true;
      },
    );
    const connection = {
      getConfirmChannel: jest.fn(() => channel),
    };
    const publisher = new RabbitMqPublisher(
      connection as unknown as RabbitMqConnection,
      new ConfigService({
        RABBITMQ_ORDERS_EXCHANGE: 'ecommerce.events',
        RABBITMQ_CONFIRM_TIMEOUT_MS: '100',
      }),
    );

    await expect(publisher.publish(event)).resolves.toBeUndefined();
    const publishedBody = channel.publish.mock.calls[0][2] as Buffer;
    expect(channel.publish).toHaveBeenCalledWith(
      'ecommerce.events',
      event.eventType,
      Buffer.from(
        JSON.stringify({
          eventId: 'event-1',
          eventType: 'order.created.v1',
          eventVersion: 1,
          occurredAt: '2026-10-31T00:00:00.000Z',
          aggregateId: 'order-1',
          correlationId: 'event-1',
          causationId: null,
          payload: { orderId: 'order-1' },
        }),
      ),
      expect.objectContaining({
        persistent: true,
        mandatory: true,
        messageId: event.id,
        type: event.eventType,
        headers: expect.objectContaining({ eventVersion: 1 }),
      }),
      expect.any(Function),
    );
    expect(JSON.parse(publishedBody.toString('utf8'))).toMatchObject({
      eventVersion: 1,
      eventId: event.id,
    });
  });

  it('rejects events that RabbitMQ returns as unroutable despite confirmation', async () => {
    const channel = new EventEmitter() as EventEmitter & {
      publish: jest.Mock;
    };
    channel.publish = jest.fn(
      (
        _exchange: string,
        routingKey: string,
        _body: Buffer,
        options: { messageId: string },
        confirm: (error?: Error | null) => void,
      ) => {
        const returnedMessage = {
          properties: { messageId: options.messageId },
          fields: { routingKey },
        } as Message;
        channel.emit('return', returnedMessage);
        confirm();
        return true;
      },
    );
    const connection = {
      getConfirmChannel: jest.fn(() => channel),
    };
    const publisher = new RabbitMqPublisher(
      connection as unknown as RabbitMqConnection,
      new ConfigService({ RABBITMQ_CONFIRM_TIMEOUT_MS: '100' }),
    );

    await expect(publisher.publish(event)).rejects.toThrow('did not route');
  });

  it('publishes payment commands using the command envelope at the root', async () => {
    const channel = new EventEmitter() as EventEmitter & {
      publish: jest.Mock;
    };
    channel.publish = jest.fn(
      (
        _exchange: string,
        _routingKey: string,
        _body: Buffer,
        _options: Record<string, unknown>,
        confirm: (error?: Error | null) => void,
      ) => {
        confirm();
        return true;
      },
    );
    const publisher = new RabbitMqPublisher(
      {
        getConfirmChannel: jest.fn(() => channel),
      } as unknown as RabbitMqConnection,
      new ConfigService({ RABBITMQ_CONFIRM_TIMEOUT_MS: '100' }),
    );
    const command: OutboxEvent = {
      id: 'outbox-1',
      aggregateType: 'Order',
      aggregateId: 'order-1',
      eventType: 'payment.authorize.v1',
      payload: {
        commandId: 'command-1',
        commandType: 'payment.authorize.v1',
        eventVersion: 1,
        occurredAt: '2026-10-31T00:00:00.000Z',
        aggregateId: 'order-1',
        correlationId: 'correlation-1',
        causationId: 'inventory-event-1',
        payload: {
          orderId: 'order-1',
          customerId: 'customer-1',
          paymentOperationId: 'operation-1',
          amount: '25.0000',
          currency: 'USD',
        },
      },
      attempts: 0,
    };

    await expect(publisher.publish(command)).resolves.toBeUndefined();
    const body = channel.publish.mock.calls[0][2] as Buffer;
    expect(JSON.parse(body.toString('utf8'))).toEqual(command.payload);
    expect(channel.publish).toHaveBeenCalledWith(
      'ecommerce.events',
      command.eventType,
      expect.any(Buffer),
      expect.objectContaining({ messageId: 'command-1' }),
      expect.any(Function),
    );
  });

  it('rejects events without a valid occurrence timestamp', async () => {
    const connection = {
      getConfirmChannel: jest.fn(),
    };
    const publisher = new RabbitMqPublisher(
      connection as unknown as RabbitMqConnection,
      new ConfigService(),
    );

    await expect(
      publisher.publish({
        ...event,
        payload: { orderId: 'order-1' },
      }),
    ).rejects.toThrow('no valid occurredAt timestamp');
    expect(connection.getConfirmChannel).not.toHaveBeenCalled();
  });
});
