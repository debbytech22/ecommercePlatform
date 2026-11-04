import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { OrderEntity, OrderStatus } from '../entities/order.entity';
import { OrderStatusHistoryEntity } from '../entities/order-status-history.entity';

export class OrderStatusHistoryService {
  static async recordInitial(
    manager: EntityManager,
    order: OrderEntity,
    details: {
      reasonCode: string;
      reason: string;
      correlationId: string | null;
      causationId: string | null;
    },
  ): Promise<void> {
    await manager.getRepository(OrderStatusHistoryEntity).insert({
      id: randomUUID(),
      orderId: order.id,
      sequenceNumber: 1,
      fromStatus: null,
      toStatus: order.status,
      reasonCode: details.reasonCode,
      reason: details.reason,
      correlationId: details.correlationId,
      causationId: details.causationId,
      occurredAt: new Date(),
    });
  }

  static async transition(
    manager: EntityManager,
    order: OrderEntity,
    nextStatus: OrderStatus,
    details: {
      reasonCode: string;
      reason: string;
      correlationId: string | null;
      causationId: string | null;
    },
  ): Promise<void> {
    const orders = manager.getRepository(OrderEntity);
    const persistedOrder = await orders
      .createQueryBuilder('order')
      .setLock('pessimistic_write')
      .where('order.id = :orderId', { orderId: order.id })
      .getOne();
    if (!persistedOrder) throw new Error(`Order ${order.id} does not exist`);
    if (persistedOrder.status !== order.status) {
      throw new Error(`Order ${order.id} status changed during transition`);
    }
    if (persistedOrder.status === nextStatus) return;

    const historyRepository = manager.getRepository(OrderStatusHistoryEntity);
    const sequenceRow = await historyRepository
      .createQueryBuilder('history')
      .select('COALESCE(MAX(history.sequenceNumber), 0) + 1', 'nextSequence')
      .where('history.orderId = :orderId', { orderId: order.id })
      .maxExecutionTime(3000)
      .getRawOne<{ nextSequence: number | string }>();
    const sequenceNumber = Number(sequenceRow?.nextSequence);
    if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1) {
      throw new Error(`Could not allocate order ${order.id} history sequence`);
    }

    const previousStatus = persistedOrder.status;
    persistedOrder.status = nextStatus;
    order.status = nextStatus;
    await orders.save(persistedOrder);
    await historyRepository.insert({
      id: randomUUID(),
      orderId: order.id,
      sequenceNumber,
      fromStatus: previousStatus,
      toStatus: nextStatus,
      reasonCode: details.reasonCode,
      reason: details.reason,
      correlationId: details.correlationId,
      causationId: details.causationId,
      occurredAt: new Date(),
    });
  }
}
