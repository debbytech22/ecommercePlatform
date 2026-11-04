import { jest } from '@jest/globals';
import { QueryFailedError } from 'typeorm';

import { InboxService } from './inbox.service';
import {
  InboxEventEntity,
  InboxEventStatus,
} from './entities/inbox-event.entity';

describe('InboxService', () => {
  const eventId = '00000000-0000-0000-0000-000000000001';
  const eventType = 'order.created.v1';

  it('records processing, runs business work, and marks processed in one transaction', async () => {
    const calls: string[] = [];
    const manager = {
      insert: jest.fn(async () => {
        calls.push('inbox-insert');
      }),
      update: jest.fn(async () => {
        calls.push('processed-update');
        return { affected: 1 };
      }),
    };
    const transaction = jest
      .fn<(operation: (manager: never) => Promise<void>) => Promise<void>>()
      .mockImplementation((operation) => operation(manager as never));
    const dataSource = { transaction };
    const service = new InboxService(dataSource as never);
    const operation = jest.fn(async () => {
      calls.push('business-work');
    });

    await expect(
      service.processOnce(eventId, eventType, operation),
    ).resolves.toBe('processed');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(manager.insert).toHaveBeenCalledWith(
      InboxEventEntity,
      expect.objectContaining({
        eventId,
        eventType,
        status: InboxEventStatus.PROCESSING,
      }),
    );
    expect(operation).toHaveBeenCalledWith(manager);
    expect(manager.update).toHaveBeenCalledWith(
      InboxEventEntity,
      { eventId, status: InboxEventStatus.PROCESSING },
      expect.objectContaining({ status: InboxEventStatus.PROCESSED }),
    );
    expect(calls).toEqual([
      'inbox-insert',
      'business-work',
      'processed-update',
    ]);
  });

  it('rolls back inbox processing when business work fails', async () => {
    const manager = {
      insert: jest.fn(async () => undefined),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    const transaction = jest
      .fn<(operation: (manager: never) => Promise<void>) => Promise<void>>()
      .mockImplementation((operation) => operation(manager as never));
    const service = new InboxService({ transaction } as never);
    const businessFailure = new Error('reservation database failure');

    await expect(
      service.processOnce(eventId, eventType, async () => {
        throw businessFailure;
      }),
    ).rejects.toBe(businessFailure);

    expect(manager.insert).toHaveBeenCalledTimes(1);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('does not repeat business work for an already processed event', async () => {
    const duplicateError = new QueryFailedError(
      'INSERT INTO inbox_events',
      [],
      Object.assign(new Error('duplicate key'), { code: 'ER_DUP_ENTRY' }),
    );
    const transaction = jest
      .fn<(operation: (manager: never) => Promise<void>) => Promise<void>>()
      .mockRejectedValue(duplicateError);
    const findOneBy = jest.fn().mockResolvedValue({
      eventId,
      eventType,
      status: InboxEventStatus.PROCESSED,
    });
    const dataSource = {
      transaction,
      getRepository: jest.fn(() => ({ findOneBy })),
    };
    const service = new InboxService(dataSource as never);
    const operation = jest.fn(async () => undefined);

    await expect(
      service.processOnce(eventId, eventType, operation),
    ).resolves.toBe('duplicate');
    expect(operation).not.toHaveBeenCalled();
    expect(findOneBy).toHaveBeenCalledWith({ eventId });
  });

  it('does not classify a business uniqueness violation as an inbox duplicate', async () => {
    const duplicateError = new QueryFailedError(
      'INSERT INTO inventory_reservations',
      [],
      Object.assign(new Error('duplicate key'), { code: 'ER_DUP_ENTRY' }),
    );
    const manager = {
      insert: jest.fn(async () => undefined),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    const transaction = jest
      .fn<(operation: (manager: never) => Promise<void>) => Promise<void>>()
      .mockImplementation((operation) => operation(manager as never));
    const service = new InboxService({ transaction } as never);

    await expect(
      service.processOnce(eventId, eventType, async () => {
        throw duplicateError;
      }),
    ).rejects.toBe(duplicateError);
  });
});
