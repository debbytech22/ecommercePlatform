import { jest } from '@jest/globals';
import type { EntityManager } from 'typeorm';
import type { InventoryReleaseCommand } from 'default/contracts';
import { InboxService } from '../../inbox/inbox.service';
import { ReservationReleaseService } from '../../reservations/compensation/reservation-release.service';
import { InventoryReleaseConsumer } from './inventory-release.consumer';

describe('InventoryReleaseConsumer', () => {
  const command: InventoryReleaseCommand = {
    commandId: 'command-1',
    commandType: 'inventory.release.v1',
    eventVersion: 1,
    aggregateId: 'order-1',
    occurredAt: '2026-11-02T12:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'cancel-event-1',
    payload: {
      orderId: 'order-1',
      sagaId: 'saga-1',
      reservationId: 'reservation-1',
      releaseOperationId: 'release-operation-1',
      reasonCode: 'ORDER_COMPENSATION',
    },
  };

  it('processes the release through the Inbox transaction', async () => {
    const manager = {} as EntityManager;
    const processOnce = jest
      .fn<
        (
          id: string,
          type: string,
          operation: (manager: EntityManager) => Promise<void>,
        ) => Promise<'processed' | 'duplicate'>
      >()
      .mockResolvedValue('processed');
    const release = jest
      .fn<
        (
          value: InventoryReleaseCommand,
          manager: EntityManager,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    const consumer = new InventoryReleaseConsumer(
      { processOnce } as unknown as InboxService,
      { release } as unknown as ReservationReleaseService,
    );

    await expect(consumer.consume(command)).resolves.toBe('processed');
    expect(processOnce).toHaveBeenCalledWith(
      command.commandId,
      command.commandType,
      expect.any(Function),
    );
    await processOnce.mock.calls[0][2](manager);
    expect(release).toHaveBeenCalledWith(command, manager);
  });

  it('rejects invalid command identity and order association', async () => {
    const processOnce = jest.fn();
    const consumer = new InventoryReleaseConsumer(
      { processOnce } as unknown as InboxService,
      { release: jest.fn() } as unknown as ReservationReleaseService,
    );

    await expect(
      consumer.consume({
        ...command,
        payload: { ...command.payload, orderId: 'other-order' },
      }),
    ).rejects.toThrow('Invalid inventory.release.v1');
    expect(processOnce).not.toHaveBeenCalled();
  });
});
