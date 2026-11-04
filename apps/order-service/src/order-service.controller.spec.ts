import { jest } from '@jest/globals';
import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import { OrderGrpcController } from './order-service.controller';
import { OrderServiceService } from './order-service.service';

describe('OrderGrpcController', () => {
  let controller: OrderGrpcController;
  let orderService: {
    createOrder: jest.Mock;
    getOrder: jest.Mock;
    getCustomerOrders: jest.Mock;
    getOrderStatus: jest.Mock;
    getOrderTimeline: jest.Mock;
  };

  beforeEach(async () => {
    orderService = {
      createOrder: jest.fn(),
      getOrder: jest.fn(),
      getCustomerOrders: jest.fn(),
      getOrderStatus: jest.fn(),
      getOrderTimeline: jest.fn(),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [OrderGrpcController],
      providers: [
        {
          provide: OrderServiceService,
          useValue: orderService,
        },
      ],
    }).compile();

    controller = app.get<OrderGrpcController>(OrderGrpcController);
  });

  it('passes the authenticated customer ID to order creation', async () => {
    const request = {
      customerId: 'untrusted-request-value',
      idempotencyKey: 'key-0123456789abcd',
      items: [],
    };
    const metadata = new Metadata();
    metadata.set('x-authenticated-customer-id', ' customer-123 ');
    const response = { orderId: 'order-123', status: 'PENDING' };
    orderService.createOrder.mockResolvedValue(response);

    await expect(controller.createOrder(request, metadata)).resolves.toBe(
      response,
    );
    expect(orderService.createOrder).toHaveBeenCalledWith(
      request,
      'customer-123',
    );
  });

  it('passes the authenticated customer ID to order retrieval', async () => {
    const request = { orderId: 'order-123' };
    const metadata = new Metadata();
    metadata.set('x-authenticated-customer-id', 'customer-123');
    const response = { orderId: 'order-123' };
    orderService.getOrder.mockResolvedValue(response);

    await expect(controller.getOrder(request, metadata)).resolves.toBe(
      response,
    );
    expect(orderService.getOrder).toHaveBeenCalledWith(
      request,
      'customer-123',
      null,
    );
  });

  it('passes ownership and correlation metadata to query RPCs', async () => {
    const metadata = new Metadata();
    metadata.set('x-authenticated-customer-id', 'customer-123');
    metadata.set('x-correlation-id', 'corr-123');
    const listRequest = {
      customerId: 'untrusted',
      page: 1,
      limit: 20,
      status: '',
    };
    const statusRequest = { orderId: 'order-123' };
    const timelineRequest = { orderId: 'order-123' };
    orderService.getCustomerOrders.mockResolvedValue({ orders: [] });
    orderService.getOrderStatus.mockResolvedValue({ status: 'CONFIRMED' });
    orderService.getOrderTimeline.mockResolvedValue({ entries: [] });

    await controller.getCustomerOrders(listRequest, metadata);
    await controller.getOrderStatus(statusRequest, metadata);
    await controller.getOrderTimeline(timelineRequest, metadata);

    expect(orderService.getCustomerOrders).toHaveBeenCalledWith(
      listRequest,
      'customer-123',
      'corr-123',
    );
    expect(orderService.getOrderStatus).toHaveBeenCalledWith(
      statusRequest,
      'customer-123',
      'corr-123',
    );
    expect(orderService.getOrderTimeline).toHaveBeenCalledWith(
      timelineRequest,
      'customer-123',
      'corr-123',
    );
  });

  it('rejects requests without authenticated customer identity', () => {
    expect(() =>
      controller.createOrder(
        {
          customerId: 'customer-123',
          idempotencyKey: 'key-0123456789abcd',
          items: [],
        },
        new Metadata(),
      ),
    ).toThrow(RpcException);
  });

  it('does not forward an invalid authenticated customer ID', async () => {
    const metadata = new Metadata();
    metadata.set('x-authenticated-customer-id', ' ');

    expect(() =>
      controller.getOrder({ orderId: 'order-123' }, metadata),
    ).toThrow(RpcException);
    expect(orderService.getOrder).not.toHaveBeenCalled();
  });
});
