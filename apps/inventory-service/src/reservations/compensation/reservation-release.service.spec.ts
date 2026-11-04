import { ConflictException } from '@nestjs/common';
import { jest } from '@jest/globals';
import type { EntityManager } from 'typeorm';
import type { InventoryReleaseCommand } from 'default/contracts';
import { OutboxEventEntity } from '../../outbox/entities/outbox-event.entity';
import { ReservationsService } from '../reservations.service';
import { ReservationReleaseService } from './reservation-release.service';

describe('ReservationReleaseService', () => {
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

  function setup() {
    const save = jest.fn(async (value: Record<string, unknown>) => value);
    const manager = {
      getRepository: jest.fn(() => ({
        create: jest.fn((value: Record<string, unknown>) => value),
        save,
      })),
    } as unknown as EntityManager;
    const reservations = {
      releaseReservation: jest
        .fn<
          (
            reservationId: string,
            orderId: string,
            manager: EntityManager,
            releaseOperationId: string,
          ) => Promise<{
            status: 'released' | 'already-released';
            items: { productId: string; quantity: number }[];
          }>
        >()
        .mockResolvedValue({
          status: 'released',
          items: [{ productId: 'product-1', quantity: 2 }],
        }),
    } as unknown as ReservationsService;
    return {
      manager,
      reservations,
      save,
      service: new ReservationReleaseService(reservations),
    };
  }

  it('releases the matching reservation and persists its result in Outbox', async () => {
    const test = setup();

    await test.service.release(command, test.manager);

    expect(test.reservations.releaseReservation).toHaveBeenCalledWith(
      'reservation-1',
      'order-1',
      test.manager,
      'release-operation-1',
    );
    expect(test.manager.getRepository).toHaveBeenCalledWith(OutboxEventEntity);
    expect(test.save).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'inventory.released.v1',
        aggregateId: 'order-1',
        payload: expect.objectContaining({
          eventType: 'inventory.released.v1',
          correlationId: 'correlation-1',
          causationId: 'command-1',
          payload: {
            orderId: 'order-1',
            sagaId: 'saga-1',
            reservationId: 'reservation-1',
            releaseOperationId: 'release-operation-1',
            releasedItems: [{ productId: 'product-1', quantity: 2 }],
          },
        }),
      }),
    );
  });

  it('persists a stable failure result for a reservation conflict', async () => {
    const test = setup();
    jest
      .mocked(test.reservations.releaseReservation)
      .mockRejectedValue(
        new ConflictException('Reservation cannot be released'),
      );

    await test.service.release(command, test.manager);

    expect(test.save).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'inventory.release_failed.v1',
        payload: expect.objectContaining({
          causationId: 'command-1',
          payload: expect.objectContaining({
            releaseOperationId: 'release-operation-1',
            reasonCode: 'RESERVATION_NOT_RELEASABLE',
          }),
        }),
      }),
    );
  });
});
