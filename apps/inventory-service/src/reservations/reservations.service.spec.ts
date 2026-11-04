import { jest } from '@jest/globals';
import type { OrderCreatedEvent } from 'default/contracts';
import type { DataSource, EntityManager } from 'typeorm';

import { ProductInventoryEntity } from '../inventory/entities/product-inventory.entity';
import { OutboxEventEntity } from '../outbox/entities/outbox-event.entity';
import { InventoryReservationItemEntity } from './entities/inventory-reservation-item.entity';
import {
  InventoryReservationEntity,
  InventoryReservationStatus,
} from './entities/inventory-reservation.entity';
import { ReservationsService } from './reservations.service';

describe('ReservationsService', () => {
  const event: OrderCreatedEvent = {
    eventId: '00000000-0000-0000-0000-000000000101',
    eventType: 'order.created.v1',
    eventVersion: 1,
    aggregateId: '00000000-0000-0000-0000-000000000201',
    occurredAt: '2026-10-31T12:00:00.000Z',
    correlationId: '00000000-0000-0000-0000-000000000301',
    causationId: null,
    payload: {
      orderId: '00000000-0000-0000-0000-000000000201',
      customerId: 'customer-1',
      currency: 'USD',
      subtotalAmount: '15.0000',
      totalAmount: '15.0000',
      items: [
        {
          productId: 'product-a',
          productName: 'Product A',
          quantity: 2,
          unitPrice: '5.0000',
          lineTotal: '10.0000',
        },
        {
          productId: 'product-b',
          productName: 'Product B',
          quantity: 1,
          unitPrice: '5.0000',
          lineTotal: '5.0000',
        },
      ],
    },
  };

  function makeManager(inventoryRows: ProductInventoryEntity[]) {
    const calls: string[] = [];
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => {
        calls.push('lock-inventory');
        return inventoryRows;
      }),
    };
    const inventoryRepository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
      save: jest.fn(async (rows: ProductInventoryEntity[]) => {
        calls.push('save-inventory');
        return rows;
      }),
    };
    const reservationRepository = {
      findOneBy: jest.fn(async () => null),
      create: jest.fn((value: Partial<InventoryReservationEntity>) => value),
      save: jest.fn(async (value: Partial<InventoryReservationEntity>) => {
        calls.push('save-reservation');
        return value;
      }),
    };
    const reservationItemRepository = {
      create: jest.fn(
        (value: Partial<InventoryReservationItemEntity>) => value,
      ),
      save: jest.fn(async (rows: Partial<InventoryReservationItemEntity>[]) => {
        calls.push('save-reservation-items');
        return rows;
      }),
    };
    const outboxRepository = {
      create: jest.fn((value: Partial<OutboxEventEntity>) => value),
      save: jest.fn(async (value: Partial<OutboxEventEntity>) => {
        calls.push('save-outbox');
        return value;
      }),
    };
    const repositories = new Map<unknown, unknown>([
      [ProductInventoryEntity, inventoryRepository],
      [InventoryReservationEntity, reservationRepository],
      [InventoryReservationItemEntity, reservationItemRepository],
      [OutboxEventEntity, outboxRepository],
    ]);
    const manager = {
      getRepository: jest.fn((entity: unknown) => repositories.get(entity)),
    };

    return {
      calls,
      manager,
      queryBuilder,
      inventoryRepository,
      reservationRepository,
      reservationItemRepository,
      outboxRepository,
    };
  }

  it('reserves every item and records reservation and outbox event using the supplied transaction manager', async () => {
    const inventoryRows = [
      {
        productId: 'product-a',
        onHand: 10,
        reserved: 1,
      },
      {
        productId: 'product-b',
        onHand: 4,
        reserved: 0,
      },
    ] as ProductInventoryEntity[];
    const context = makeManager(inventoryRows);
    const service = new ReservationsService({} as DataSource);

    await service.reserveOrder(
      event,
      context.manager as unknown as EntityManager,
    );

    expect(context.queryBuilder.setLock).toHaveBeenCalledWith(
      'pessimistic_write',
    );
    expect(context.reservationRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: event.payload.orderId,
        status: InventoryReservationStatus.RESERVED,
      }),
    );
    expect(inventoryRows.map(({ reserved }) => reserved)).toEqual([3, 1]);
    expect(context.inventoryRepository.save).toHaveBeenCalledWith(
      inventoryRows,
    );
    expect(context.reservationItemRepository.save).toHaveBeenCalledTimes(1);
    expect(context.outboxRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'inventory.reserved.v1',
        aggregateId: event.payload.orderId,
      }),
    );
    expect(context.calls).toEqual([
      'lock-inventory',
      'save-reservation',
      'save-reservation-items',
      'save-inventory',
      'save-outbox',
    ]);
  });

  it('fails the whole reservation if any item is short without changing stock or creating reservation items', async () => {
    const inventoryRows = [
      {
        productId: 'product-a',
        onHand: 10,
        reserved: 1,
      },
      {
        productId: 'product-b',
        onHand: 0,
        reserved: 0,
      },
    ] as ProductInventoryEntity[];
    const originalReserved = inventoryRows.map(({ reserved }) => reserved);
    const context = makeManager(inventoryRows);
    const service = new ReservationsService({} as DataSource);

    await service.reserveOrder(
      event,
      context.manager as unknown as EntityManager,
    );

    expect(inventoryRows.map(({ reserved }) => reserved)).toEqual(
      originalReserved,
    );
    expect(context.inventoryRepository.save).not.toHaveBeenCalled();
    expect(context.reservationItemRepository.save).not.toHaveBeenCalled();
    expect(context.reservationRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: InventoryReservationStatus.FAILED,
      }),
    );
    expect(context.outboxRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'inventory.reservation_failed.v1',
      }),
    );
    expect(context.calls).toEqual([
      'lock-inventory',
      'save-reservation',
      'save-outbox',
    ]);
  });

  it('fails without stock changes when a requested product does not exist', async () => {
    const inventoryRows = [
      {
        productId: 'product-a',
        onHand: 10,
        reserved: 1,
      },
    ] as ProductInventoryEntity[];
    const context = makeManager(inventoryRows);
    const service = new ReservationsService({} as DataSource);

    await service.reserveOrder(
      event,
      context.manager as unknown as EntityManager,
    );

    expect(context.inventoryRepository.save).not.toHaveBeenCalled();
    expect(context.reservationItemRepository.save).not.toHaveBeenCalled();
    const outboxEvent = context.outboxRepository.create.mock.calls[0][0];
    expect(outboxEvent.eventType).toBe('inventory.reservation_failed.v1');
    expect(outboxEvent.payload).toMatchObject({
      payload: {
        reasonCode: 'PRODUCT_NOT_FOUND',
      },
    });
  });

  it('releases reserved stock transactionally and treats repeated release as a no-op', async () => {
    const reservation = {
      id: 'reservation-1',
      orderId: event.payload.orderId,
      status: InventoryReservationStatus.RESERVED,
    } as InventoryReservationEntity;
    const inventoryRows = [
      { productId: 'product-a', onHand: 10, reserved: 3 },
      { productId: 'product-b', onHand: 4, reserved: 1 },
    ] as ProductInventoryEntity[];
    const items = [
      { reservationId: reservation.id, productId: 'product-a', quantity: 2 },
      { reservationId: reservation.id, productId: 'product-b', quantity: 1 },
    ] as InventoryReservationItemEntity[];
    const reservationQuery = {
      where: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => reservation),
    };
    const inventoryQuery = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => inventoryRows),
    };
    const reservationRepository = {
      createQueryBuilder: jest.fn(() => reservationQuery),
      save: jest.fn(async (value: InventoryReservationEntity) => value),
    };
    const itemRepository = { find: jest.fn(async () => items) };
    const inventoryRepository = {
      createQueryBuilder: jest.fn(() => inventoryQuery),
      save: jest.fn(async (rows: ProductInventoryEntity[]) => rows),
    };
    const repositories = new Map<unknown, unknown>([
      [InventoryReservationEntity, reservationRepository],
      [InventoryReservationItemEntity, itemRepository],
      [ProductInventoryEntity, inventoryRepository],
    ]);
    const manager = {
      getRepository: jest.fn((entity: unknown) => repositories.get(entity)),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: async <T>(
        operation: (transactionManager: EntityManager) => Promise<T>,
      ) => operation(manager),
    } as DataSource;
    const service = new ReservationsService(dataSource);

    await expect(
      service.releaseReservation(
        reservation.id,
        reservation.orderId,
        undefined,
        'release-operation-1',
      ),
    ).resolves.toMatchObject({
      status: 'released',
      items: [
        { productId: 'product-a', quantity: 2 },
        { productId: 'product-b', quantity: 1 },
      ],
    });
    await expect(
      service.releaseReservation(
        reservation.id,
        reservation.orderId,
        undefined,
        'release-operation-1',
      ),
    ).resolves.toMatchObject({
      status: 'already-released',
      items: [
        { productId: 'product-a', quantity: 2 },
        { productId: 'product-b', quantity: 1 },
      ],
    });

    expect(inventoryRows.map(({ reserved }) => reserved)).toEqual([1, 0]);
    expect(inventoryRepository.save).toHaveBeenCalledTimes(1);
    expect(reservation.status).toBe(InventoryReservationStatus.RELEASED);
    expect(reservation.releaseOperationId).toBe('release-operation-1');
    expect(reservationRepository.save).toHaveBeenCalledTimes(1);
    expect(reservationQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
    await expect(
      service.releaseReservation(
        reservation.id,
        reservation.orderId,
        undefined,
        'different-release-operation',
      ),
    ).rejects.toThrow('already assigned to a different release operation');
    expect(inventoryRepository.save).toHaveBeenCalledTimes(1);
  });

  it('does not release failed reservations', async () => {
    const reservation = {
      id: 'reservation-failed',
      orderId: event.payload.orderId,
      status: InventoryReservationStatus.FAILED,
    } as InventoryReservationEntity;
    const reservationQuery = {
      where: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => reservation),
    };
    const manager = {
      getRepository: jest.fn(() => ({
        createQueryBuilder: jest.fn(() => reservationQuery),
      })),
    };
    const dataSource = {
      transaction: async <T>(
        operation: (transactionManager: EntityManager) => Promise<T>,
      ) => operation(manager as unknown as EntityManager),
    } as DataSource;
    const service = new ReservationsService(dataSource);

    await expect(
      service.releaseReservation(reservation.id, reservation.orderId),
    ).rejects.toThrow(
      'Only a successful inventory reservation can be released',
    );
    expect(reservation.status).toBe(InventoryReservationStatus.FAILED);
  });
});
