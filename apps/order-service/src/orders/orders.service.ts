import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { OrderEntity } from './entities/order.entity';
import { OrderItemEntity } from '../entities/order-item.entity';

@Injectable()
export class OrdersService {
  findForUpdate(manager: EntityManager, orderId: string): Promise<OrderEntity> {
    return manager.getRepository(OrderEntity).findOneOrFail({
      where: { id: orderId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  findItems(manager: EntityManager, orderId: string): Promise<OrderItemEntity[]> {
    return manager.getRepository(OrderItemEntity).find({
      where: { order: { id: orderId } },
      order: { productId: 'ASC' },
    });
  }
}
