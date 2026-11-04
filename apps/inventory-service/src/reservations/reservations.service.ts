import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  InventoryReservationFailedEvent,
  InventoryReservedEvent,
  OrderCreatedEvent,
} from 'default/contracts';
import {
  INVENTORY_RESERVATION_FAILED_EVENT_TYPE,
  INVENTORY_RESERVED_EVENT_TYPE,
} from 'default/contracts';
import { DataSource, type EntityManager } from 'typeorm';

import { ProductInventoryEntity } from '../inventory/entities/product-inventory.entity';
import { InventoryReservationItemEntity } from './entities/inventory-reservation-item.entity';
import {
  InventoryReservationEntity,
  InventoryReservationStatus,
} from './entities/inventory-reservation.entity';
import { OutboxEventEntity } from '../outbox/entities/outbox-event.entity';

export interface ReleasedReservationItem {
  productId: string;
  quantity: number;
}

export interface ReservationReleaseResult {
  status: 'released' | 'already-released';
  items: ReleasedReservationItem[];
}

export interface ReservationInspection {
  reservationId: string;
  orderId: string;
  status: InventoryReservationStatus;
  releaseOperationId: string | null;
  items: Array<{ productId: string; quantity: number }>;
  hasPendingOutboxEvent: boolean;
}

@Injectable()
export class ReservationsService {
  constructor(private readonly dataSource: DataSource) {}

  async reserveOrder(
    event: OrderCreatedEvent,
    manager: EntityManager,
  ): Promise<void> {
    const existingReservation = await manager
      .getRepository(InventoryReservationEntity)
      .findOneBy({ orderId: event.payload.orderId });
    if (existingReservation) {
      throw new ConflictException(
        `Order ${event.payload.orderId} already has an inventory reservation`,
      );
    }

    const items = [...event.payload.items].sort((a, b) =>
      a.productId.localeCompare(b.productId),
    );
    const productIds = items.map(({ productId }) => productId);
    const inventoryRows = await manager
      .getRepository(ProductInventoryEntity)
      .createQueryBuilder('inventory')
      .where('inventory.productId IN (:...productIds)', { productIds })
      .orderBy('inventory.productId', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    const inventoryByProductId = new Map(
      inventoryRows.map((row) => [row.productId, row]),
    );
    const unavailableItems = items.flatMap((item) => {
      const inventory = inventoryByProductId.get(item.productId);
      const available = inventory
        ? inventory.onHand - inventory.reserved
        : null;
      return available === null || available < item.quantity
        ? [
            {
              productId: item.productId,
              requestedQuantity: item.quantity,
              availableQuantity: available,
            },
          ]
        : [];
    });

    const reservationId = randomUUID();
    const reservations = manager.getRepository(InventoryReservationEntity);
    const reservation = reservations.create({
      id: reservationId,
      orderId: event.payload.orderId,
      releaseOperationId: null,
      status:
        unavailableItems.length === 0
          ? InventoryReservationStatus.RESERVED
          : InventoryReservationStatus.FAILED,
    });
    await reservations.save(reservation);

    if (unavailableItems.length > 0) {
      const failureEvent: InventoryReservationFailedEvent = {
        eventId: randomUUID(),
        eventType: INVENTORY_RESERVATION_FAILED_EVENT_TYPE,
        eventVersion: 1,
        aggregateId: event.payload.orderId,
        occurredAt: new Date().toISOString(),
        correlationId: event.correlationId,
        causationId: event.eventId,
        payload: {
          orderId: event.payload.orderId,
          reasonCode: unavailableItems.some(
            (item) => item.availableQuantity === null,
          )
            ? 'PRODUCT_NOT_FOUND'
            : 'INSUFFICIENT_STOCK',
          reason: 'One or more requested products cannot be reserved',
          items: unavailableItems,
        },
      };
      await this.saveOutboxEvent(manager, failureEvent);
      return;
    }

    const reservationItems = manager.getRepository(
      InventoryReservationItemEntity,
    );
    await reservationItems.save(
      items.map((item) =>
        reservationItems.create({
          id: randomUUID(),
          reservationId,
          productId: item.productId,
          quantity: item.quantity,
        }),
      ),
    );

    for (const item of items) {
      const inventory = inventoryByProductId.get(item.productId)!;
      inventory.reserved += item.quantity;
    }
    await manager.getRepository(ProductInventoryEntity).save(inventoryRows);

    const reservedEvent: InventoryReservedEvent = {
      eventId: randomUUID(),
      eventType: INVENTORY_RESERVED_EVENT_TYPE,
      eventVersion: 1,
      aggregateId: event.payload.orderId,
      occurredAt: new Date().toISOString(),
      correlationId: event.correlationId,
      causationId: event.eventId,
      payload: {
        orderId: event.payload.orderId,
        reservationId,
        items: items.map(({ productId, quantity }) => ({
          productId,
          quantity,
        })),
      },
    };
    await this.saveOutboxEvent(manager, reservedEvent);
  }

  /**
   * Inspect a reservation by its ID for safe recovery.
   * Returns null if no reservation exists — never throws for a missing record.
   * Checks all six conditions required by Phase 8 step 6:
   *  1. Does the reservation exist?
   *  2. Does it belong to the expected order?
   *  3. Is it RESERVED, RELEASED, or COMMITTED (FAILED)?
   *  4. Does the recorded quantity match the order?
   *  5. Has a release operation already been completed?
   *  6. Is there a pending result event in the Inventory Outbox?
   */
  async inspectReservation(
    reservationId: string,
    expectedOrderId: string,
  ): Promise<ReservationInspection | null> {
    return this.dataSource.transaction(async (manager) => {
      const reservation = await manager
        .getRepository(InventoryReservationEntity)
        .findOneBy({ id: reservationId });

      if (!reservation) return null;

      const items = await manager
        .getRepository(InventoryReservationItemEntity)
        .find({ where: { reservationId }, order: { productId: 'ASC' } });

      const [outboxRow] = (await manager.query(
        "SELECT `id` FROM `inventory_outbox_events` WHERE `aggregate_id` = ? AND `published_at` IS NULL AND `failed_at` IS NULL AND `event_type` IN ('inventory.reserved.v1', 'inventory.released.v1', 'inventory.release_failed.v1') LIMIT 1",
        [expectedOrderId],
      )) as Array<{ id: string }>;

      return {
        reservationId: reservation.id,
        orderId: reservation.orderId,
        status: reservation.status,
        releaseOperationId: reservation.releaseOperationId,
        items: items.map(({ productId, quantity }) => ({ productId, quantity })),
        hasPendingOutboxEvent: outboxRow !== undefined,
      };
    });
  }

  /**
   * Find a reservation by order ID — used when the Order Service knows the
   * orderId but not the reservationId (e.g. after a crash before the saga
   * persisted the reservation ID).
   */
  async findReservationByOrderId(
    orderId: string,
  ): Promise<ReservationInspection | null> {
    const reservation = await this.dataSource
      .getRepository(InventoryReservationEntity)
      .findOneBy({ orderId });
    if (!reservation) return null;
    return this.inspectReservation(reservation.id, orderId);
  }

  async releaseReservation(
    reservationId: string,
    expectedOrderId: string,
    transactionManager?: EntityManager,
    releaseOperationId?: string,
  ): Promise<ReservationReleaseResult> {
    if (
      typeof reservationId !== 'string' ||
      reservationId.trim().length === 0 ||
      reservationId.length > 36 ||
      typeof expectedOrderId !== 'string' ||
      expectedOrderId.trim().length === 0 ||
      expectedOrderId.length > 36 ||
      (releaseOperationId !== undefined &&
        (typeof releaseOperationId !== 'string' ||
          releaseOperationId.trim().length === 0 ||
          releaseOperationId.length > 36))
    ) {
      throw new ConflictException(
        'Valid reservation and order IDs are required',
      );
    }

    const release = (manager: EntityManager) =>
      this.releaseReservationInTransaction(
        manager,
        reservationId,
        expectedOrderId,
        releaseOperationId,
      );
    return transactionManager
      ? release(transactionManager)
      : this.dataSource.transaction(release);
  }

  private async releaseReservationInTransaction(
    manager: EntityManager,
    reservationId: string,
    expectedOrderId: string,
    releaseOperationId?: string,
  ): Promise<ReservationReleaseResult> {
    const reservations = manager.getRepository(InventoryReservationEntity);
    const reservation = await reservations
      .createQueryBuilder('reservation')
      .where('reservation.id = :reservationId', { reservationId })
      .setLock('pessimistic_write')
      .getOne();

    if (!reservation) {
      throw new NotFoundException('Inventory reservation was not found');
    }
    if (reservation.orderId !== expectedOrderId) {
      throw new ConflictException(
        'Inventory reservation does not belong to the requested order',
      );
    }
    if (
      reservation.releaseOperationId &&
      reservation.releaseOperationId !== releaseOperationId
    ) {
      throw new ConflictException(
        'Reservation was already assigned to a different release operation',
      );
    }
    if (reservation.status === InventoryReservationStatus.RELEASED) {
      if (releaseOperationId && !reservation.releaseOperationId) {
        reservation.releaseOperationId = releaseOperationId;
        await reservations.save(reservation);
      }
      const items = await manager
        .getRepository(InventoryReservationItemEntity)
        .find({
          where: { reservationId },
          order: { productId: 'ASC' },
        });
      return {
        status: 'already-released',
        items: items.map(({ productId, quantity }) => ({
          productId,
          quantity,
        })),
      };
    }
    if (reservation.status !== InventoryReservationStatus.RESERVED) {
      throw new ConflictException(
        'Only a successful inventory reservation can be released',
      );
    }
    if (releaseOperationId) {
      reservation.releaseOperationId = releaseOperationId;
    }

    const reservationItems = await manager
      .getRepository(InventoryReservationItemEntity)
      .find({
        where: { reservationId },
        order: { productId: 'ASC' },
      });
    if (reservationItems.length === 0) {
      throw new Error(
        `Reserved inventory ${reservationId} has no reservation items`,
      );
    }

    const productIds = reservationItems.map(({ productId }) => productId);
    const inventoryRows = await manager
      .getRepository(ProductInventoryEntity)
      .createQueryBuilder('inventory')
      .where('inventory.productId IN (:...productIds)', { productIds })
      .orderBy('inventory.productId', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    const inventoryByProductId = new Map(
      inventoryRows.map((row) => [row.productId, row]),
    );

    for (const item of reservationItems) {
      const inventory = inventoryByProductId.get(item.productId);
      if (!inventory || inventory.reserved < item.quantity) {
        throw new Error(
          `Inventory reservation ${reservationId} cannot be safely released`,
        );
      }
    }

    for (const item of reservationItems) {
      inventoryByProductId.get(item.productId)!.reserved -= item.quantity;
    }
    await manager.getRepository(ProductInventoryEntity).save(inventoryRows);
    reservation.status = InventoryReservationStatus.RELEASED;
    await reservations.save(reservation);
    return {
      status: 'released',
      items: reservationItems.map(({ productId, quantity }) => ({
        productId,
        quantity,
      })),
    };
  }

  private async saveOutboxEvent(
    manager: EntityManager,
    event: InventoryReservedEvent | InventoryReservationFailedEvent,
  ): Promise<void> {
    const repository = manager.getRepository(OutboxEventEntity);
    await repository.save(
      repository.create({
        id: event.eventId,
        aggregateType: 'Order',
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: { ...event },
        publishedAt: null,
      }),
    );
  }
}
