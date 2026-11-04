import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';

import {
  OrderCreatedConsumer,
  UnprocessableOrderEventError,
} from '../consumers/order-created.consumer';
import { InventoryReleaseConsumer } from '../consumers/inventory-release.consumer';
import { InventoryMetricsService } from '../../observability/inventory-metrics.service';
import { RabbitMqPublisherChannel } from './rabbitmq.publisher-channel';
import { RabbitMqConsumer } from './rabbitmq.consumer';

describe('RabbitMqConsumer delivery recovery', () => {
  function makeConsumer(
    consume: (event: unknown) => Promise<unknown>,
    sendToQueue: (...args: unknown[]) => boolean,
  ) {
    const confirmChannel = Object.assign(new EventEmitter(), {
      sendToQueue,
    }) as unknown as ConfirmChannel;
    const publisherChannel = {
      getConfirmChannel: jest.fn(() => confirmChannel),
    } as unknown as RabbitMqPublisherChannel;
    const config = {
      get: (_name: string, defaultValue?: string) => defaultValue,
    } as ConfigService;
    const orderCreated = {
      consume,
    } as unknown as OrderCreatedConsumer;
    const inventoryRelease = {
      consume,
    } as unknown as InventoryReleaseConsumer;
    const metrics = {
      recordConsumerOutcome: jest.fn(),
      recordConsumerDuration: jest.fn(),
    } as unknown as InventoryMetricsService;
    return new RabbitMqConsumer(
      config,
      orderCreated,
      inventoryRelease,
      publisherChannel,
      metrics,
    );
  }

  function makeMessage(retryCount = 0): ConsumeMessage {
    return {
      content: Buffer.from('{"eventId":"event-1"}'),
      fields: { routingKey: 'order.created.v1' },
      properties: {
        messageId: 'event-1',
        headers: { 'x-inventory-retry-count': retryCount },
      },
    } as unknown as ConsumeMessage;
  }

  it('confirms a delayed retry copy before acknowledging a transient failure', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const sendToQueue = jest.fn(
      (
        _queue: unknown,
        _content: unknown,
        _options: unknown,
        confirm: (error?: Error | null) => void,
      ) => {
        confirm(null);
        return true;
      },
    );
    const consumer = makeConsumer(async () => {
      throw Object.assign(new Error('deadlock'), {
        code: 'ER_LOCK_DEADLOCK',
      });

      it('dispatches inventory release commands to the release consumer', async () => {
        const consume = jest
          .fn<(...args: unknown[]) => Promise<unknown>>()
          .mockResolvedValue('processed');
        const consumer = makeConsumer(consume, jest.fn());
        const message = {
          ...makeMessage(),
          content: Buffer.from('{"commandType":"inventory.release.v1"}'),
          fields: { routingKey: 'inventory.release.v1' },
        } as ConsumeMessage;

        await consumer['handleDelivery'](
          {
            ack: jest.fn(),
            nack: jest.fn(),
          } as unknown as import('amqplib').Channel,
          message,
        );

        expect(consume).toHaveBeenCalledWith({
          commandType: 'inventory.release.v1',
        });
      });
    }, sendToQueue);
    const message = makeMessage();
    const ack = jest.fn();
    const nack = jest.fn();
    const channel = { ack, nack } as unknown as import('amqplib').Channel;

    await consumer['handleDelivery'](channel, message);

    expect(sendToQueue).toHaveBeenCalledWith(
      'inventory.order-created.retry',
      message.content,
      expect.objectContaining({
        persistent: true,
        mandatory: true,
        expiration: '1000',
        messageId: 'event-1',
        headers: expect.objectContaining({
          'x-inventory-retry-count': 1,
        }),
      }),
      expect.any(Function),
    );
    expect(ack).toHaveBeenCalledWith(message);
    expect(nack).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('routes malformed events directly to the durable dead-letter queue', async () => {
    const sendToQueue = jest.fn();
    const consumer = makeConsumer(async () => {
      throw new UnprocessableOrderEventError('Invalid event');
    }, sendToQueue);
    const message = makeMessage();
    const ack = jest.fn();
    const nack = jest.fn();

    await consumer['handleDelivery'](
      { ack, nack } as unknown as import('amqplib').Channel,
      message,
    );

    expect(nack).toHaveBeenCalledWith(message, false, false);
    expect(sendToQueue).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('dead-letters a transient failure after the configured retry limit', async () => {
    const sendToQueue = jest.fn();
    const consumer = makeConsumer(async () => {
      throw Object.assign(new Error('deadlock'), {
        code: 'ER_LOCK_DEADLOCK',
      });
    }, sendToQueue);
    const message = makeMessage(5);
    const nack = jest.fn();

    await consumer['handleDelivery'](
      { ack: jest.fn(), nack } as unknown as import('amqplib').Channel,
      message,
    );

    expect(nack).toHaveBeenCalledWith(message, false, false);
    expect(sendToQueue).not.toHaveBeenCalled();
  });

  it('requeues the original if retry publication is not confirmed', async () => {
    const sendToQueue = jest.fn(
      (
        _queue: unknown,
        _content: unknown,
        _options: unknown,
        confirm: (error?: Error | null) => void,
      ) => {
        confirm(new Error('publisher disconnected'));
        return true;
      },
    );
    const consumer = makeConsumer(async () => {
      throw Object.assign(new Error('deadlock'), {
        code: 'ER_LOCK_DEADLOCK',
      });
    }, sendToQueue);
    const message = makeMessage();
    const nack = jest.fn();

    await consumer['handleDelivery'](
      { ack: jest.fn(), nack } as unknown as import('amqplib').Channel,
      message,
    );

    expect(nack).toHaveBeenCalledWith(message, false, true);
  });
});
