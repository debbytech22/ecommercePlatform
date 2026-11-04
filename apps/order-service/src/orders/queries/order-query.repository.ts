import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OrderEntity } from '../../entities/order.entity';
import { OrderItemEntity } from '../../entities/order-item.entity';
import { OrderStatusHistoryEntity } from '../../entities/order-status-history.entity';
import type { ListOrdersDto } from './dto/list-orders.dto';

@Injectable()
export class OrderQueryRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Finds a single order by ID, enforcing customer ownership at the DB level.
   * Returns null for both missing and unauthorized orders to prevent enumeration.
   */
  findCustomerOrder(
    orderId: string,
    customerId: string,
  ): Promise<OrderEntity | null> {
    return this.dataSource
      .getRepository(OrderEntity)
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.items', 'item')
      .where('o.id = :orderId', { orderId })
      .andWhere('o.customerId = :customerId', { customerId })
      .maxExecutionTime(3000)
      .getOne();
  }

  /**
   * Finds a single order by ID + customer without loading items.
   * Used for status-only lookups.
   */
  findCustomerOrderShallow(
    orderId: string,
    customerId: string,
  ): Promise<OrderEntity | null> {
    return this.dataSource
      .getRepository(OrderEntity)
      .createQueryBuilder('o')
      .where('o.id = :orderId', { orderId })
      .andWhere('o.customerId = :customerId', { customerId })
      .maxExecutionTime(3000)
      .getOne();
  }

  /**
   * Returns a paginated, filtered list of a customer's orders.
   * Sorted by (created_at DESC, id DESC) for stable ordering.
   */
  async findCustomerOrders(
    dto: ListOrdersDto,
  ): Promise<{ rows: OrderEntity[]; total: number }> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const qb = manager
        .getRepository(OrderEntity)
        .createQueryBuilder('o')
        .where('o.customerId = :customerId', { customerId: dto.customerId });
      qb.maxExecutionTime(3000);

      if (dto.status) {
        qb.andWhere('o.status = :status', { status: dto.status });
      }

      const [rows, total] = await qb
        .orderBy('o.createdAt', 'DESC')
        .addOrderBy('o.id', 'DESC')
        .skip((dto.page - 1) * dto.limit)
        .take(dto.limit)
        .getManyAndCount();

      if (rows.length > 0) {
        const counts = await manager
          .getRepository(OrderItemEntity)
          .createQueryBuilder('item')
          .select('item.orderId', 'orderId')
          .addSelect('COUNT(*)', 'count')
          .where('item.orderId IN (:...orderIds)', {
            orderIds: rows.map((order) => order.id),
          })
          .groupBy('item.orderId')
          .maxExecutionTime(3000)
          .getRawMany<{ orderId: string; count: string }>();
        const countByOrderId = new Map(
          counts.map((row) => [row.orderId, Number(row.count)]),
        );
        for (const order of rows) {
          order.itemCount = countByOrderId.get(order.id) ?? 0;
        }
      }

      return { rows, total };
    });
  }

  /**
   * Returns the full status transition history for an order.
   * Ownership is verified by first confirming the order belongs to the customer.
   */
  async findOrderTimeline(
    orderId: string,
    customerId: string,
  ): Promise<{
    order: OrderEntity;
    history: OrderStatusHistoryEntity[];
  } | null> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const order = await manager
        .getRepository(OrderEntity)
        .createQueryBuilder('o')
        .where('o.id = :orderId', { orderId })
        .andWhere('o.customerId = :customerId', { customerId })
        .maxExecutionTime(3000)
        .getOne();
      if (!order) return null;

      const history = await manager
        .getRepository(OrderStatusHistoryEntity)
        .createQueryBuilder('h')
        .where('h.orderId = :orderId', { orderId })
        .orderBy('h.sequenceNumber', 'ASC')
        .maxExecutionTime(3000)
        .getMany();

      return { order, history };
    });
  }
}
