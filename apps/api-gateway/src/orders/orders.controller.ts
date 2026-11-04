import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OrdersGrpcClient } from './orders.grpc-client';
import { GetOrdersQueryDto } from './dto/order-query.dto';
import {
  OrderAccessGuard,
  OrderRateLimitGuard,
} from './guards/order-access.guard';
import type { AuthenticatedRequest } from './guards/order-access.guard';

@Controller('orders')
@UseGuards(OrderAccessGuard, OrderRateLimitGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersGrpcClient) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Query() query: GetOrdersQueryDto,
    @Req() request: AuthenticatedRequest,
    @Headers('x-correlation-id') correlationHeader?: string,
  ) {
    const page = this.parsePositiveInteger(query.page, 1, 'page');
    const limit = this.parsePositiveInteger(query.limit, 20, 'limit');
    if (page > 1_000_000) {
      throw new BadRequestException('page is outside the supported range');
    }
    if (limit > 50) {
      throw new BadRequestException('limit must not exceed 50');
    }
    if (
      query.status !== undefined &&
      (typeof query.status !== 'string' || query.status.length > 40)
    ) {
      throw new BadRequestException('status is too long');
    }
    return this.orders.getCustomerOrders(
      {
        customerId: request.user.customerId,
        page,
        limit,
        status: query.status ?? '',
      },
      this.correlationId(correlationHeader),
    );
  }

  @Get(':orderId/status')
  @Header('Cache-Control', 'no-store')
  getStatus(
    @Param('orderId') orderId: string,
    @Req() request: AuthenticatedRequest,
    @Headers('x-correlation-id') correlationHeader?: string,
  ) {
    return this.orders.getOrderStatus(
      this.requireOrderId(orderId),
      request.user.customerId,
      this.correlationId(correlationHeader),
    );
  }

  @Get(':orderId/timeline')
  @Header('Cache-Control', 'no-store')
  getTimeline(
    @Param('orderId') orderId: string,
    @Req() request: AuthenticatedRequest,
    @Headers('x-correlation-id') correlationHeader?: string,
  ) {
    return this.orders.getOrderTimeline(
      this.requireOrderId(orderId),
      request.user.customerId,
      this.correlationId(correlationHeader),
    );
  }

  @Get(':orderId')
  @Header('Cache-Control', 'no-store')
  getOrder(
    @Param('orderId') orderId: string,
    @Req() request: AuthenticatedRequest,
    @Headers('x-correlation-id') correlationHeader?: string,
  ) {
    return this.orders.getOrder(
      this.requireOrderId(orderId),
      request.user.customerId,
      this.correlationId(correlationHeader),
    );
  }

  private requireOrderId(orderId: string): string {
    const normalized = orderId?.trim();
    if (!normalized || normalized.length > 36) {
      throw new BadRequestException('A valid order ID is required');
    }
    return normalized;
  }

  private parsePositiveInteger(
    value: string | undefined,
    defaultValue: number,
    name: string,
  ): number {
    if (value === undefined) return defaultValue;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
      throw new BadRequestException(`${name} must be a positive integer`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new BadRequestException(`${name} is outside the supported range`);
    }
    return parsed;
  }

  private correlationId(value?: string): string {
    const normalized = value?.trim();
    return normalized && /^[A-Za-z0-9._:-]{1,128}$/.test(normalized)
      ? normalized
      : randomUUID();
  }
}
