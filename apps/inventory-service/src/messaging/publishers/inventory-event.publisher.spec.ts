import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { ConfirmChannel } from 'amqplib';
import type {
  InventoryReservationFailedEvent,
  InventoryReservedEvent,
} from 'default/contracts';

import { InventoryEventPublisher } from './inventory-event.publisher';
import { RabbitMqPublisherChannel } from '../rabbitmq/rabbitmq.publisher-channel';

describe('InventoryEventPublisher', () => {
  const event: InventoryReservedEvent = {
    eventId: '00000000-0000-0000-0000-000000000401',
    eventType: 'inventory.reserved.v1',
    eventVersion: 1,
    aggregateId: '00000000-0000-0000-0000-000000000201',
    occurredAt: '2026-10-31T12:00:00.000Z',
    correlationId: '00000000-0000-0000-0000-000000000301',
    causationId: '00000000-0000-0000-0000-000000000101',
    payload: {
      orderId: '00000000-0000-0000-0000-000000000201',
      reservationId: '00000000-0000-0000-0000-000000000501',
      items: [{ productId: 'product-a', quantity: 2 }],
    },
  };
  const failureEvent: InventoryReservationFailedEvent = {
    eventId: '00000000-0000-0000-0000-000000000402',
    eventType: 'inventory.reservation_failed.v1',
    eventVersion: 1,
    aggregateId: '00000000-0000-0000-0000-000000000201',
    occurredAt: '2026-10-31T12:00:00.000Z',
    correlationId: '00000000-0000-0000-0000-000000000301',
    causationId: '00000000-0000-0000-0000-000000000101',
    payload: {
      orderId: '00000000-0000-0000-0000-000000000201',
      reasonCode: 'INSUFFICIENT_STOCK',
      reason: 'One or more requested products cannot be reserved',
      items: [
        {
          productId: 'product-a',
          requestedQuantity: 2,
          availableQuantity: 1,
        },
      ],
    },
  };

  function makePublisher(
    publish: (...args: unknown[]) => boolean,
    channelEmitter = new EventEmitter(),
  ) {
    const channel = Object.assign(channelEmitter, {
      publish,
    }) as unknown as ConfirmChannel;
    const connection = {
      getConfirmChannel: jest.fn(() => channel),
    } as unknown as RabbitMqPublisherChannel;
    const config = {
      get: (name: string, defaultValue?: string) =>
        name === 'RABBITMQ_ORDERS_EXCHANGE' ? 'ecommerce.events' : defaultValue,
    } as ConfigService;
    return new InventoryEventPublisher(connection, config);
  }

  it('publishes the full event to its versioned key as a persistent confirmed message', async () => {
    const publish = jest.fn((...args: unknown[]) => {
      const callback = args[4] as (error?: Error | null) => void;
      callback(null);
      return true;
    });
    const publisher = makePublisher(publish);

    await publisher.publish(event);

    expect(publish).toHaveBeenCalledWith(
      'ecommerce.events',
      'inventory.reserved.v1',
      expect.any(Buffer),
      expect.objectContaining({
        persistent: true,
        mandatory: true,
        messageId: event.eventId,
        type: event.eventType,
        contentType: 'application/json',
      }),
      expect.any(Function),
    );
    expect(JSON.parse(publish.mock.calls[0][2]!.toString())).toEqual(event);
  });

  it('rejects publishing when RabbitMQ nacks the event', async () => {
    const publish = jest.fn((...args: unknown[]) => {
      const callback = args[4] as (error?: Error | null) => void;
      callback(new Error('broker rejected event'));
      return true;
    });
    const publisher = makePublisher(publish);

    await expect(publisher.publish(event)).rejects.toThrow(
      'broker rejected event',
    );
  });

  it('publishes the reservation failure on the requested versioned routing key', async () => {
    const publish = jest.fn((...args: unknown[]) => {
      const callback = args[4] as (error?: Error | null) => void;
      callback(null);
      return true;
    });
    const publisher = makePublisher(publish);

    await publisher.publish(failureEvent);

    expect(publish).toHaveBeenCalledWith(
      'ecommerce.events',
      'inventory.reservation_failed.v1',
      expect.any(Buffer),
      expect.objectContaining({ persistent: true }),
      expect.any(Function),
    );
    expect(JSON.parse(publish.mock.calls[0][2]!.toString())).toEqual(
      failureEvent,
    );
  });

  it('rejects an unroutable event even when the broker confirms the publish', async () => {
    const emitter = new EventEmitter();
    const publish = jest.fn((...args: unknown[]) => {
      const options = args[3] as { messageId: string };
      emitter.emit('return', {
        properties: { messageId: options.messageId },
        fields: { routingKey: event.eventType },
      });
      const callback = args[4] as (error?: Error | null) => void;
      callback(null);
      return true;
    });
    const publisher = makePublisher(publish, emitter);

    await expect(publisher.publish(event)).rejects.toThrow('did not route');
  });
});
