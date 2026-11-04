import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import { OutboxPublisherService } from './outbox-publisher.service';
import type { OutboxRepository } from './outbox.repository';
import type { OutboxPublisher } from './outbox-event.types';

describe('OutboxPublisherService', () => {
  const event = {
    id: 'outbox-event-1',
    aggregateType: 'Order',
    aggregateId: 'order-1',
    eventType: 'order.created.v1',
    payload: { eventId: 'outbox-event-1', orderId: 'order-1' },
    attempts: 0,
  };

  it('marks an event published only after the broker confirms it', async () => {
    const calls: string[] = [];
    const repository = {
      claimBatch: jest.fn().mockResolvedValue({
        claimToken: 'claim-1',
        events: [event],
      }),
      markPublished: jest.fn().mockImplementation(async () => {
        calls.push('marked');
        return true;
      }),
      scheduleRetry: jest.fn(),
    };
    const publisher = {
      publish: jest.fn().mockImplementation(async () => {
        calls.push('confirmed');
      }),
    };
    const service = new OutboxPublisherService(
      repository as unknown as OutboxRepository,
      publisher as OutboxPublisher,
      new ConfigService(),
    );

    await service.poll();

    expect(calls).toEqual(['confirmed', 'marked']);
    expect(repository.markPublished).toHaveBeenCalledWith(event.id, 'claim-1');
    expect(repository.scheduleRetry).not.toHaveBeenCalled();
  });

  it('schedules a retry and does not mark events published when confirmation fails', async () => {
    const repository = {
      claimBatch: jest.fn().mockResolvedValue({
        claimToken: 'claim-2',
        events: [{ ...event, attempts: 1 }],
      }),
      markPublished: jest.fn(),
      scheduleRetry: jest.fn().mockResolvedValue('scheduled'),
    };
    const publisher = {
      publish: jest.fn().mockRejectedValue(new Error('broker nack')),
    };
    const service = new OutboxPublisherService(
      repository as unknown as OutboxRepository,
      publisher as OutboxPublisher,
      new ConfigService(),
    );
    const loggerError = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => undefined);

    await service.poll();

    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(repository.scheduleRetry).toHaveBeenCalledWith(
      event.id,
      'claim-2',
      2000,
      'broker nack',
      1,
      10,
    );
    loggerError.mockRestore();
  });

  it('schedules redelivery with the same event ID if publishing is confirmed but marking it fails', async () => {
    const repository = {
      claimBatch: jest.fn().mockResolvedValue({
        claimToken: 'claim-after-confirm',
        events: [event],
      }),
      markPublished: jest
        .fn()
        .mockRejectedValue(new Error('database connection lost')),
      scheduleRetry: jest.fn().mockResolvedValue('scheduled'),
    };
    const publisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    };
    const service = new OutboxPublisherService(
      repository as unknown as OutboxRepository,
      publisher as OutboxPublisher,
      new ConfigService(),
    );
    const loggerError = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => undefined);

    await service.poll();

    expect(publisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({ id: event.id }),
    );
    expect(repository.markPublished).toHaveBeenCalledWith(
      event.id,
      'claim-after-confirm',
    );
    expect(repository.scheduleRetry).toHaveBeenCalledWith(
      event.id,
      'claim-after-confirm',
      1000,
      'database connection lost',
      0,
      10,
    );
    loggerError.mockRestore();
  });

  it('moves an event to manual intervention after the maximum attempts', async () => {
    const repository = {
      claimBatch: jest.fn().mockResolvedValue({
        claimToken: 'claim-exhausted',
        events: [{ ...event, attempts: 9 }],
      }),
      markPublished: jest.fn(),
      scheduleRetry: jest.fn().mockResolvedValue('exhausted'),
    };
    const publisher = {
      publish: jest
        .fn()
        .mockRejectedValue(new Error('persistent broker error')),
    };
    const service = new OutboxPublisherService(
      repository as unknown as OutboxRepository,
      publisher as OutboxPublisher,
      new ConfigService({ OUTBOX_MAX_ATTEMPTS: '10' }),
    );
    const loggerError = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => undefined);

    await service.poll();

    expect(repository.scheduleRetry).toHaveBeenCalledWith(
      event.id,
      'claim-exhausted',
      expect.any(Number),
      'persistent broker error',
      9,
      10,
    );
    expect(repository.markPublished).not.toHaveBeenCalled();
    loggerError.mockRestore();
  });
});
