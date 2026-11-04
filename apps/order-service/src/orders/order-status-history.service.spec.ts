import { jest } from '@jest/globals';
import type { EntityManager } from 'typeorm';
import { OrderEntity, OrderStatus } from '../entities/order.entity';
import { OrderStatusHistoryEntity } from '../entities/order-status-history.entity';
import { OrderStatusHistoryService } from './order-status-history.service';

describe('OrderStatusHistoryService', () => {
  it('updates status and inserts its audit record through the same manager', async () => {
    const order = {
      id: 'order-123',
      status: OrderStatus.PROCESSING_PAYMENT,
    } as OrderEntity;
    const save = jest.fn().mockResolvedValue(order);
    const insert = jest.fn().mockResolvedValue(undefined);
    const orderQueryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(order),
    };
    const historyQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      maxExecutionTime: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ nextSequence: '1' }),
    };
    const getRepository = jest.fn((entity: unknown) =>
      entity === OrderEntity
        ? { save, createQueryBuilder: () => orderQueryBuilder }
        : {
            insert,
            createQueryBuilder: () => historyQueryBuilder,
          },
    );
    const manager = {
      getRepository,
    } as unknown as EntityManager;

    await OrderStatusHistoryService.transition(
      manager,
      order,
      OrderStatus.CONFIRMED,
      {
        reasonCode: 'ORDER_CONFIRMED',
        reason: 'Order confirmed',
        correlationId: 'correlation-123',
        causationId: 'event-123',
      },
    );

    expect(order.status).toBe(OrderStatus.CONFIRMED);
    expect(save).toHaveBeenCalledWith(order);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-123',
        sequenceNumber: 1,
        fromStatus: OrderStatus.PROCESSING_PAYMENT,
        toStatus: OrderStatus.CONFIRMED,
        reasonCode: 'ORDER_CONFIRMED',
        correlationId: 'correlation-123',
        causationId: 'event-123',
        occurredAt: expect.any(Date),
      }),
    );
    expect(getRepository).toHaveBeenCalledWith(OrderStatusHistoryEntity);
  });

  it('does not create another history row for a duplicate status transition', async () => {
    const insert = jest.fn();
    const save = jest.fn();
    const orderQueryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        id: 'order-123',
        status: OrderStatus.CONFIRMED,
      }),
    };
    const manager = {
      getRepository: () => ({
        save,
        insert,
        createQueryBuilder: () => orderQueryBuilder,
      }),
    } as unknown as EntityManager;

    await OrderStatusHistoryService.transition(
      manager,
      { id: 'order-123', status: OrderStatus.CONFIRMED } as OrderEntity,
      OrderStatus.CONFIRMED,
      {
        reasonCode: 'ORDER_CONFIRMED',
        reason: 'Order confirmed',
        correlationId: null,
        causationId: null,
      },
    );

    expect(save).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
