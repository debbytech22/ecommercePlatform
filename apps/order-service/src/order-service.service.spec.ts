import { status } from '@grpc/grpc-js';
import { jest } from '@jest/globals';
import { RpcException } from '@nestjs/microservices';
import { createHash } from 'node:crypto';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import type { CreateOrderRequest } from 'default/contracts';

import { OrderEntity } from './entities/order.entity';
import { OrderStatusHistoryEntity } from './entities/order-status-history.entity';
import { OrderItemEntity } from './entities/order-item.entity';
import { OutboxEventEntity } from './entities/outbox-event.entity';
import { OrderServiceService } from './order-service.service';
import type { ProductPricingPort } from './pricing/product-pricing.port';
import { SagaInitializerService } from './saga/services/saga-initializer.service';
import { OrderQueryRepository } from './orders/queries/order-query.repository';
import { OrderQueryMetricsService } from './orders/queries/order-query-metrics.service';

describe('OrderServiceService catalog pricing', () => {
  const request: CreateOrderRequest = {
    customerId: 'ignored-client-customer',
    idempotencyKey: 'key-0123456789abcd',
    items: [{ productId: 'product-1', quantity: 2 }],
  };

  function createService(prices: unknown) {
    const dataSource = {
      transaction: jest.fn(),
    };
    const orders = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    const pricing = {
      getPrices:
        prices instanceof Error
          ? jest.fn().mockRejectedValue(prices)
          : jest.fn().mockResolvedValue(prices),
    } as ProductPricingPort;
    const sagaInitializer = {
      initialize: jest.fn().mockResolvedValue(undefined),
    } as unknown as SagaInitializerService;
    const orderQueries = {
      findCustomerOrder: jest.fn(),
      findCustomerOrderShallow: jest.fn(),
      findCustomerOrders: jest.fn(),
      findOrderTimeline: jest.fn(),
    } as unknown as OrderQueryRepository;
    const queryMetrics = {
      recordSuccess: jest.fn(),
      recordError: jest.fn(),
      recordGrpcFailure: jest.fn(),
    } as unknown as OrderQueryMetricsService;

    return {
      service: new OrderServiceService(
        dataSource as unknown as DataSource,
        orders as unknown as Repository<OrderEntity>,
        orderQueries,
        queryMetrics,
        pricing,
        sagaInitializer,
      ),
      dataSource,
      orders,
      pricing,
    };
  }

  async function expectRpcStatus(
    promise: Promise<unknown>,
    expectedStatus: number,
  ): Promise<void> {
    try {
      await promise;
      throw new Error('Expected the operation to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      if (!(error instanceof RpcException)) {
        return;
      }

      expect(error.getError()).toMatchObject({ code: expectedStatus });
    }
  }

  it('returns an existing order for an identical idempotent request', async () => {
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          customerId: 'customer-1',
          items: [{ productId: 'product-1', quantity: 2 }],
        }),
      )
      .digest('hex');
    const existingOrder = {
      id: 'existing-order',
      customerId: 'customer-1',
      idempotencyKey: request.idempotencyKey,
      requestHash,
      status: 'PENDING',
    };
    const { service, dataSource, orders, pricing } = createService([]);
    orders.findOne.mockResolvedValue(existingOrder as OrderEntity);

    await expect(service.createOrder(request, 'customer-1')).resolves.toEqual({
      orderId: 'existing-order',
      status: 'PENDING',
    });
    expect(pricing.getPrices).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects reusing an idempotency key with different order contents', async () => {
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          customerId: 'customer-1',
          items: [{ productId: 'product-1', quantity: 2 }],
        }),
      )
      .digest('hex');
    const existingOrder = {
      id: 'existing-order',
      customerId: 'customer-1',
      idempotencyKey: request.idempotencyKey,
      requestHash,
      status: 'PENDING',
    };
    const { service, dataSource, orders, pricing } = createService([]);
    orders.findOne.mockResolvedValue(existingOrder as OrderEntity);

    await expectRpcStatus(
      service.createOrder(
        { ...request, items: [{ productId: 'product-1', quantity: 3 }] },
        'customer-1',
      ),
      status.ALREADY_EXISTS,
    );
    expect(pricing.getPrices).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('resolves a concurrent duplicate-key insert using the stored request fingerprint', async () => {
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          customerId: 'customer-1',
          items: [{ productId: 'product-1', quantity: 2 }],
        }),
      )
      .digest('hex');
    const racedOrder = {
      id: 'concurrent-order',
      customerId: 'customer-1',
      idempotencyKey: request.idempotencyKey,
      requestHash,
      status: 'PENDING',
    };
    const duplicateError = Object.assign(new Error('Duplicate key'), {
      driverError: { code: 'ER_DUP_ENTRY' },
    });
    const orderRepository = {
      create: jest.fn((value) => value),
      save: jest.fn().mockRejectedValue(duplicateError),
    };
    const manager = {
      getRepository: jest.fn(() => orderRepository),
    };
    const dataSource = {
      transaction: jest.fn(
        async (operation: (value: EntityManager) => Promise<unknown>) =>
          operation(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const orders = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(racedOrder),
    } as unknown as Repository<OrderEntity>;
    const pricing = {
      getPrices: jest.fn().mockResolvedValue([
        {
          productId: 'product-1',
          productName: 'Product',
          unitPrice: '1.2500',
          currency: 'USD',
          active: true,
        },
      ]),
    } as ProductPricingPort;
    const service = new OrderServiceService(
      dataSource,
      orders,
      {} as unknown as OrderQueryRepository,
      {} as unknown as OrderQueryMetricsService,
      pricing,
      {
        initialize: jest.fn().mockResolvedValue(undefined),
      } as unknown as SagaInitializerService,
    );

    await expect(service.createOrder(request, 'customer-1')).resolves.toEqual({
      orderId: 'concurrent-order',
      status: 'PENDING',
    });
  });

  it('does not start an order transaction when catalog pricing is unavailable', async () => {
    const { service, dataSource } = createService(
      new Error('catalog unavailable'),
    );

    await expectRpcStatus(
      service.createOrder(request, 'customer-1'),
      status.UNAVAILABLE,
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['missing product', []],
    [
      'inactive product',
      [
        {
          productId: 'product-1',
          productName: 'Product',
          unitPrice: '1.0000',
          currency: 'USD',
          active: false,
        },
      ],
    ],
    [
      'incomplete product',
      [
        {
          productId: 'product-1',
          productName: '',
          unitPrice: '1.0000',
          currency: 'USD',
          active: true,
        },
      ],
    ],
  ])('does not create an order for a %s', async (_caseName, prices) => {
    const { service, dataSource } = createService(prices);

    await expectRpcStatus(
      service.createOrder(request, 'customer-1'),
      status.FAILED_PRECONDITION,
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('persists order, items, and outbox event atomically and returns the saved order', async () => {
    const savedOrder = {
      id: 'persisted-order-id',
      customerId: 'authenticated-customer',
      status: 'RESERVING_INVENTORY',
    };
    const orderRepository = {
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue(savedOrder),
    };
    const itemRepository = {
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const outboxRepository = {
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const historyRepository = {
      insert: jest.fn().mockResolvedValue(undefined),
    };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === OrderEntity) return orderRepository;
        if (entity === OrderItemEntity) return itemRepository;
        if (entity === OutboxEventEntity) return outboxRepository;
        if (entity === OrderStatusHistoryEntity) return historyRepository;
        throw new Error('Unexpected repository');
      }),
    };
    let transactionCommitted = false;
    const dataSource = {
      transaction: jest.fn(
        async (operation: (value: EntityManager) => Promise<unknown>) => {
          const result = await operation(manager as unknown as EntityManager);
          transactionCommitted = true;
          return result;
        },
      ),
    } as unknown as DataSource;
    const orders = {
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as Repository<OrderEntity>;
    const pricing = {
      getPrices: jest.fn().mockResolvedValue([
        {
          productId: 'product-1',
          productName: 'Product',
          unitPrice: '1.2500',
          currency: 'USD',
          active: true,
        },
      ]),
    } as ProductPricingPort;
    const sagaInitializer = {
      initialize: jest.fn().mockResolvedValue(undefined),
    } as unknown as SagaInitializerService;
    const service = new OrderServiceService(
      dataSource,
      orders,
      {} as unknown as OrderQueryRepository,
      {} as unknown as OrderQueryMetricsService,
      pricing,
      sagaInitializer,
    );

    await expect(
      service.createOrder(request, ' authenticated-customer '),
    ).resolves.toEqual({
      orderId: 'persisted-order-id',
      status: 'RESERVING_INVENTORY',
    });

    expect(orderRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'authenticated-customer',
        subtotalAmount: '2.5000',
        totalAmount: '2.5000',
      }),
    );
    expect(historyRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'persisted-order-id',
        fromStatus: null,
        toStatus: 'RESERVING_INVENTORY',
        reasonCode: 'ORDER_CREATED',
      }),
    );
    expect(itemRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({
        order: savedOrder,
        productId: 'product-1',
        quantity: 2,
        unitPrice: '1.2500',
        lineTotal: '2.5000',
      }),
    ]);
    expect(outboxRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: 'persisted-order-id',
        eventType: 'order.created.v1',
        payload: expect.objectContaining({
          orderId: 'persisted-order-id',
          customerId: 'authenticated-customer',
          totalAmount: '2.5000',
        }),
      }),
    );
    expect(sagaInitializer.initialize).toHaveBeenCalledWith(
      manager,
      'persisted-order-id',
      expect.any(String),
    );
    const savedEvent = outboxRepository.create.mock.calls[0][0];
    expect(savedEvent.id).toBe(savedEvent.payload.eventId);
    expect(savedEvent.aggregateId).toBe(savedEvent.payload.orderId);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(transactionCommitted).toBe(true);
  });

  it.each(['order', 'items', 'outbox'])(
    'does not report success when the %s persistence operation fails',
    async (failedOperation) => {
      const failure = new Error(`${failedOperation} write failed`);
      const orderRepository = {
        create: jest.fn((value) => value),
        save:
          failedOperation === 'order'
            ? jest.fn().mockRejectedValue(failure)
            : jest.fn().mockResolvedValue({
                id: 'persisted-order-id',
                customerId: 'customer-1',
                status: 'PENDING',
              }),
      };
      const itemRepository = {
        create: jest.fn((value) => value),
        save:
          failedOperation === 'items'
            ? jest.fn().mockRejectedValue(failure)
            : jest.fn().mockResolvedValue(undefined),
      };
      const outboxRepository = {
        create: jest.fn((value) => value),
        save:
          failedOperation === 'outbox'
            ? jest.fn().mockRejectedValue(failure)
            : jest.fn().mockResolvedValue(undefined),
      };
      const historyRepository = {
        insert: jest.fn().mockResolvedValue(undefined),
      };
      const manager = {
        getRepository: jest.fn((entity) => {
          if (entity === OrderEntity) return orderRepository;
          if (entity === OrderItemEntity) return itemRepository;
          if (entity === OutboxEventEntity) return outboxRepository;
          if (entity === OrderStatusHistoryEntity) return historyRepository;
          throw new Error('Unexpected repository');
        }),
      };
      let transactionCommitted = false;
      const dataSource = {
        transaction: jest.fn(
          async (operation: (value: EntityManager) => Promise<unknown>) => {
            const result = await operation(manager as unknown as EntityManager);
            transactionCommitted = true;
            return result;
          },
        ),
      } as unknown as DataSource;
      const orders = {
        findOne: jest.fn().mockResolvedValue(null),
      } as unknown as Repository<OrderEntity>;
      const pricing = {
        getPrices: jest.fn().mockResolvedValue([
          {
            productId: 'product-1',
            productName: 'Product',
            unitPrice: '1.2500',
            currency: 'USD',
            active: true,
          },
        ]),
      } as ProductPricingPort;
      const service = new OrderServiceService(
        dataSource,
        orders,
        {} as unknown as OrderQueryRepository,
        {} as unknown as OrderQueryMetricsService,
        pricing,
        {
          initialize: jest.fn().mockResolvedValue(undefined),
        } as unknown as SagaInitializerService,
      );

      await expectRpcStatus(
        service.createOrder(request, 'customer-1'),
        status.INTERNAL,
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(orders.findOne).toHaveBeenCalledTimes(1);
      expect(transactionCommitted).toBe(false);
    },
  );
});
