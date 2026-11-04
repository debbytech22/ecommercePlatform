import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { Metadata, status } from '@grpc/grpc-js';

import type {
  CreateOrderRequest,
  CreateOrderResponse,
  GetCustomerOrdersRequest,
  GetCustomerOrdersResponse,
  GetOrderRequest,
  GetOrderResponse,
  GetOrderStatusRequest,
  GetOrderStatusResponse,
  GetOrderTimelineRequest,
  GetOrderTimelineResponse,
} from 'default/contracts';

import { OrderServiceService } from './order-service.service';

@Controller()
export class OrderGrpcController {
  constructor(private readonly orderService: OrderServiceService) {}

  @GrpcMethod('OrderService', 'CreateOrder')
  createOrder(
    request: CreateOrderRequest,
    metadata: Metadata,
  ): Promise<CreateOrderResponse> {
    return this.orderService.createOrder(
      request,
      this.requireCustomerId(metadata),
    );
  }

  @GrpcMethod('OrderService', 'GetOrder')
  getOrder(
    request: GetOrderRequest,
    metadata: Metadata,
  ): Promise<GetOrderResponse> {
    return this.orderService.getOrder(
      request,
      this.requireCustomerId(metadata),
      this.correlationId(metadata),
    );
  }

  @GrpcMethod('OrderService', 'GetOrderStatus')
  getOrderStatus(
    request: GetOrderStatusRequest,
    metadata: Metadata,
  ): Promise<GetOrderStatusResponse> {
    return this.orderService.getOrderStatus(
      request,
      this.requireCustomerId(metadata),
      this.correlationId(metadata),
    );
  }

  @GrpcMethod('OrderService', 'GetOrderTimeline')
  getOrderTimeline(
    request: GetOrderTimelineRequest,
    metadata: Metadata,
  ): Promise<GetOrderTimelineResponse> {
    return this.orderService.getOrderTimeline(
      request,
      this.requireCustomerId(metadata),
      this.correlationId(metadata),
    );
  }

  @GrpcMethod('OrderService', 'GetCustomerOrders')
  getCustomerOrders(
    request: GetCustomerOrdersRequest,
    metadata: Metadata,
  ): Promise<GetCustomerOrdersResponse> {
    return this.orderService.getCustomerOrders(
      request,
      this.requireCustomerId(metadata),
      this.correlationId(metadata),
    );
  }

  private requireCustomerId(metadata: Metadata): string {
    const values = metadata.get('x-authenticated-customer-id');
    const customerId = values[0];

    if (
      typeof customerId !== 'string' ||
      customerId.trim().length === 0 ||
      customerId.length > 64
    ) {
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Authenticated customer identity is required',
      });
    }

    return customerId.trim();
  }

  private correlationId(metadata: Metadata): string | null {
    const value = metadata.get('x-correlation-id')[0];
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 && normalized.length <= 128
      ? normalized
      : null;
  }
}
