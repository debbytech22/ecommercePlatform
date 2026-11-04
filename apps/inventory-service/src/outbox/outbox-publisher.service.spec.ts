import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { InventoryReservedEvent } from 'default/contracts';

import { InventoryEventPublisher } from '../messaging/publishers/inventory-event.publisher';
import { InventoryMetricsService } from '../observability/inventory-metrics.service';
import { OutboxPublisherService } from './outbox-publisher.service';
import type { OutboxRepository } from './outbox.repository';

describe('OutboxPublisherService', () => {
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

  function createService(
    publish: jest.Mock<(event: InventoryReservedEvent) => Promise<void>>,
  ) {
    const repository = {
      claimBatch: jest.fn(async () => ({
        claimToken: 'claim-1',
        events: [
          {
            id: event.eventId,
            eventType: event.eventType,
            payload: event,
            attempts: 0,
          },
        ],
      })),
      markPublished: jest.fn(async () => true),
      scheduleRetry: jest.fn(async () => 'scheduled' as const),
    } as unknown as OutboxRepository;
    const publisher = { publish } as unknown as InventoryEventPublisher;
    const config = {
      get: (_name: string, defaultValue?: string) => defaultValue,
    } as ConfigService;
    const inventoryMetrics = {
      renderPrometheus: () => '',
    } as InventoryMetricsService;
    return {
      repository,
      service: new OutboxPublisherService(
        repository,
        publisher,
        config,
        inventoryMetrics,
      ),
    };
  }

  it('marks an event published only after the publisher confirmation resolves', async () => {
    const publish = jest.fn(
      async (_event: InventoryReservedEvent) => undefined,
    );
    const { repository, service } = createService(publish);

    await service.poll();

    expect(publish).toHaveBeenCalledWith(event);
    expect(repository.markPublished).toHaveBeenCalledWith(
      event.eventId,
      'claim-1',
    );
    expect(repository.scheduleRetry).not.toHaveBeenCalled();
  });

  it('schedules a retry when publishing fails and does not mark the event published', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const publish = jest.fn(async (_event: InventoryReservedEvent) => {
      throw new Error('confirm failed');
    });
    const { repository, service } = createService(publish);

    await service.poll();

    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(repository.scheduleRetry).toHaveBeenCalledWith(
      event.eventId,
      'claim-1',
      1000,
      'confirm failed',
      0,
      10,
    );
    jest.restoreAllMocks();
  });
});
