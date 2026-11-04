import { jest } from '@jest/globals';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { OrderStatus } from './entities/order.entity';
import { OrderServiceService } from './order-service.service';
import { OrderQueryRepository } from './orders/queries/order-query.repository';
import { OrderQueryMetricsService } from './orders/queries/order-query-metrics.service';
import { ProductPricingPort } from './pricing/product-pricing.port';
import { SagaInitializerService } from './saga/services/saga-initializer.service';

describe('OrderServiceService retrieval', () => {
  const updatedAt = new Date('2026-11-02T10:05:00.000Z');
  const orderQueries = {
    findCustomerOrder: jest.fn(),
    findCustomerOrderShallow: jest.fn(),
    findCustomerOrders: jest.fn(),
    findOrderTimeline: jest.fn(),
  };
  const queryMetrics = {
    recordSuccess: jest.fn(),
    recordError: jest.fn(),
    recordGrpcFailure: jest.fn(),
  };
  const service = new OrderServiceService(
    {} as never,
    {} as never,
    orderQueries as unknown as OrderQueryRepository,
    queryMetrics as unknown as OrderQueryMetricsService,
    {} as ProductPricingPort,
    {} as SagaInitializerService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the persisted status and update timestamp for the owner', async () => {
    orderQueries.findCustomerOrderShallow.mockResolvedValue({
      id: 'order-123',
      status: OrderStatus.CONFIRMED,
      updatedAt,
    });

    await expect(
      service.getOrderStatus({ orderId: 'order-123' }, 'customer-123', 'corr'),
    ).resolves.toEqual({
      orderId: 'order-123',
      status: 'CONFIRMED',
      updatedAt: '2026-11-02T10:05:00.000Z',
    });
    expect(orderQueries.findCustomerOrderShallow).toHaveBeenCalledWith(
      'order-123',
      'customer-123',
    );
    expect(queryMetrics.recordSuccess).toHaveBeenCalledWith(
      'status',
      expect.any(Number),
    );
  });

  it('uses the owner-scoped repository for order details', async () => {
    orderQueries.findCustomerOrder.mockResolvedValue({
      id: 'order-123',
      customerId: 'customer-123',
      status: OrderStatus.PROCESSING_PAYMENT,
      currency: 'USD',
      subtotalAmount: '4.0000',
      totalAmount: '4.0000',
      items: [],
      createdAt: updatedAt,
      updatedAt,
    });

    const response = await service.getOrder(
      { orderId: 'order-123' },
      'customer-123',
    );

    expect(response.status).toBe('PROCESSING_PAYMENT');
    expect(orderQueries.findCustomerOrder).toHaveBeenCalledWith(
      'order-123',
      'customer-123',
    );
  });

  it('does not expose missing or unowned orders', async () => {
    orderQueries.findCustomerOrderShallow.mockResolvedValue(null);

    try {
      await service.getOrderStatus(
        { orderId: 'order-123' },
        'different-customer',
      );
      throw new Error('Expected the status query to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      expect((error as RpcException).getError()).toMatchObject({
        code: status.NOT_FOUND,
        message: 'Order not found',
      });
    }
    expect(queryMetrics.recordError).toHaveBeenCalledWith(
      'status',
      expect.any(Number),
      true,
    );
  });

  it('paginates customer orders and maps item counts from persisted rows', async () => {
    orderQueries.findCustomerOrders.mockResolvedValue({
      rows: [
        {
          id: 'order-1',
          status: OrderStatus.CONFIRMED,
          currency: 'USD',
          totalAmount: '12.0000',
          itemCount: 2,
          createdAt: updatedAt,
          updatedAt,
        },
      ],
      total: 3,
    });

    await expect(
      service.getCustomerOrders(
        { customerId: 'ignored', page: 2, limit: 1, status: 'CONFIRMED' },
        'customer-123',
      ),
    ).resolves.toEqual({
      orders: [
        {
          orderId: 'order-1',
          status: 'CONFIRMED',
          currency: 'USD',
          totalAmount: '12.0000',
          itemCount: 2,
          createdAt: '2026-11-02T10:05:00.000Z',
          updatedAt: '2026-11-02T10:05:00.000Z',
        },
      ],
      pagination: { page: 2, limit: 1, total: 3, hasNextPage: true },
    });
    expect(orderQueries.findCustomerOrders).toHaveBeenCalledWith({
      customerId: 'customer-123',
      page: 2,
      limit: 1,
      status: OrderStatus.CONFIRMED,
    });
  });

  it('returns timeline history from persistence, not transport events', async () => {
    orderQueries.findOrderTimeline.mockResolvedValue({
      order: { id: 'order-123', status: OrderStatus.CANCELLED },
      history: [
        {
          fromStatus: null,
          toStatus: OrderStatus.RESERVING_INVENTORY,
          occurredAt: updatedAt,
          reason: 'Order created',
          reasonCode: 'ORDER_CREATED',
        },
      ],
    });

    await expect(
      service.getOrderTimeline({ orderId: 'order-123' }, 'customer-123'),
    ).resolves.toEqual({
      orderId: 'order-123',
      currentStatus: 'CANCELLED',
      entries: [
        {
          fromStatus: '',
          toStatus: 'RESERVING_INVENTORY',
          occurredAt: '2026-11-02T10:05:00.000Z',
          reason: 'Order created',
          reasonCode: 'ORDER_CREATED',
        },
      ],
    });
  });
});
