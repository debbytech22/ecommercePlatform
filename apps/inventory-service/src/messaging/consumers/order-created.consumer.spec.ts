import { jest } from '@jest/globals';
import type { OrderCreatedEvent } from 'default/contracts';
import type { EntityManager } from 'typeorm';

import { InboxService } from '../../inbox/inbox.service';
import { InventoryMetricsService } from '../../observability/inventory-metrics.service';
import { ReservationsService } from '../../reservations/reservations.service';
import { OrderCreatedConsumer } from './order-created.consumer';

describe('OrderCreatedConsumer', () => {
  const event: OrderCreatedEvent = {
    eventId: 'event-1',
    eventType: 'order.created.v1',
    eventVersion: 1,
    aggregateId: 'order-1',
    occurredAt: '2026-10-31T12:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: null,
    payload: {
      orderId: 'order-1',
      customerId: 'customer-1',
      currency: 'USD',
      subtotalAmount: '2.5000',
      totalAmount: '2.5000',
      items: [
        {
          productId: 'product-1',
          productName: 'Product',
          quantity: 1,
          unitPrice: '2.5000',
          lineTotal: '2.5000',
        },
      ],
    },
  };

  it('passes validated order events and the inbox transaction manager to the reservations service', async () => {
    const manager = {} as EntityManager;
    const processOnce = jest
      .fn<
        (
          eventId: string,
          eventType: string,
          operation: (manager: EntityManager) => Promise<void>,
        ) => Promise<'processed' | 'duplicate'>
      >()
      .mockResolvedValue('processed');
    const metrics = {
      recordConsumerOutcome: jest.fn(),
      recordConsumerDuration: jest.fn(),
    } as unknown as InventoryMetricsService;
    const consumer = new OrderCreatedConsumer(
      {
        processOnce,
      } as unknown as InboxService,
      {
        reserveOrder: jest.fn(async () => undefined),
      } as unknown as ReservationsService,
      metrics,
    );

    await expect(consumer.consume(event)).resolves.toBe('processed');
    expect(processOnce).toHaveBeenCalledWith(
      event.eventId,
      event.eventType,
      expect.any(Function),
    );
    const operation = processOnce.mock.calls[0][2];
    await operation(manager);
    expect(consumer['reservations'].reserveOrder).toHaveBeenCalledWith(
      event,
      manager,
    );
    expect(metrics.recordConsumerOutcome).toHaveBeenCalledWith('processed');
    expect(metrics.recordConsumerDuration).toHaveBeenCalledWith(
      expect.any(Number),
    );
  });

  it('rejects invalid envelopes and quantities before touching the inbox', async () => {
    const processOnce = jest.fn();
    const metrics = {
      recordConsumerOutcome: jest.fn(),
      recordConsumerDuration: jest.fn(),
    } as unknown as InventoryMetricsService;
    const consumer = new OrderCreatedConsumer(
      { processOnce } as unknown as InboxService,
      { reserveOrder: jest.fn() } as unknown as ReservationsService,
      metrics,
    );

    await expect(
      consumer.consume({ ...event, aggregateId: 'different-order' }),
    ).rejects.toThrow('Invalid order.created.v1');
    await expect(
      consumer.consume({
        ...event,
        payload: {
          ...event.payload,
          items: [{ ...event.payload.items[0], quantity: 0 }],
        },
      }),
    ).rejects.toThrow('invalid order item');
    expect(processOnce).not.toHaveBeenCalled();
    expect(metrics.recordConsumerOutcome).toHaveBeenCalledWith('failed');
  });
});
