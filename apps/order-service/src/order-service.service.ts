import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { DataSource, Repository } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';

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

import { OrderEntity, OrderStatus } from './entities/order.entity';
import { OrderItemEntity } from './entities/order-item.entity';
import { OutboxEventEntity } from './entities/outbox-event.entity';
import { PRODUCT_PRICING_PORT } from './pricing/product-pricing.port';
import type {
  ProductPrice,
  ProductPricingPort,
} from './pricing/product-pricing.port';
import { calculateLineTotal, formatMoney, parseMoney } from './orders/money';
import { SagaInitializerService } from './saga/services/saga-initializer.service';
import { OrderQueryRepository } from './orders/queries/order-query.repository';
import {
  DEFAULT_PAGE_SIZE,
  ListOrdersDto,
  MAX_PAGE_SIZE,
} from './orders/queries/dto/list-orders.dto';
import { OrderQueryMetricsService } from './orders/queries/order-query-metrics.service';
import { OrderStatusHistoryService } from './orders/order-status-history.service';

const MAX_ITEMS = 50;
const MAX_QUANTITY_PER_ITEM = 1000;
const MAX_PAGE_NUMBER = 1_000_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

type DatabaseError = {
  code?: unknown;
  driverError?: {
    code?: unknown;
  };
};

@Injectable()
export class OrderServiceService {
  private readonly logger = new Logger(OrderServiceService.name);

  constructor(
    private readonly dataSource: DataSource,

    @InjectRepository(OrderEntity)
    private readonly orders: Repository<OrderEntity>,

    private readonly orderQueries: OrderQueryRepository,
    private readonly queryMetrics: OrderQueryMetricsService,
    @Inject(PRODUCT_PRICING_PORT)
    private readonly pricing: ProductPricingPort,
    private readonly sagaInitializer: SagaInitializerService,
  ) {}

  /**
   * customerId must come from authenticated gateway identity metadata,
   * forwarded over a protected service-to-service connection.
   */
  async createOrder(
    request: CreateOrderRequest,
    customerId: string,
  ): Promise<CreateOrderResponse> {
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

    this.validateRequest(request);

    const authenticatedCustomerId = customerId.trim();
    const normalizedItems = request.items
      .map(({ productId, quantity }) => ({
        productId: productId.trim(),
        quantity,
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId));

    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          customerId: authenticatedCustomerId,
          items: normalizedItems,
        }),
      )
      .digest('hex');

    // Fast path: an existing request should not depend on today's prices.
    const existing = await this.orders.findOne({
      where: {
        customerId: authenticatedCustomerId,
        idempotencyKey: request.idempotencyKey,
      },
    });

    if (existing) {
      this.assertSameRequest(existing, requestHash);
      return {
        orderId: existing.id,
        status: existing.status,
      };
    }

    // The catalog is the authority for price, name, currency and activity.
    // If it is unavailable or returns incomplete data, no order is written.
    let prices: ProductPrice[];
    try {
      prices = await this.pricing.getPrices(
        normalizedItems.map((item) => item.productId),
      );
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }

      this.logger.error(
        'Trusted pricing lookup failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw new RpcException({
        code: status.UNAVAILABLE,
        message: 'Product pricing is temporarily unavailable',
      });
    }

    if (
      !Array.isArray(prices) ||
      prices.some(
        (price) =>
          !price ||
          typeof price.productId !== 'string' ||
          typeof price.productName !== 'string' ||
          typeof price.unitPrice !== 'string' ||
          typeof price.currency !== 'string' ||
          typeof price.active !== 'boolean',
      )
    ) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Catalog returned incomplete product data',
      });
    }

    const priceById = new Map(prices.map((price) => [price.productId, price]));

    if (
      priceById.size !== normalizedItems.length ||
      normalizedItems.some((item) => !priceById.has(item.productId)) ||
      prices.some(
        (price) =>
          !normalizedItems.some((item) => item.productId === price.productId),
      )
    ) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'One or more products are unavailable for ordering',
      });
    }

    const currencies = new Set(prices.map((price) => price.currency));

    if (
      currencies.size !== 1 ||
      prices.some(
        (price) =>
          !price.active ||
          !price.productName.trim() ||
          !/^[A-Z]{3}$/.test(price.currency),
      )
    ) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Product pricing data is invalid or inconsistent',
      });
    }

    const currency = prices[0].currency;
    const orderId = randomUUID();

    const preparedItems = normalizedItems.map((item) => {
      const price = priceById.get(item.productId)!;

      try {
        // Parsing validates the decimal format and DB range.
        parseMoney(price.unitPrice);
        return {
          productId: item.productId,
          productName: price.productName,
          quantity: item.quantity,
          unitPrice: formatMoney(parseMoney(price.unitPrice)),
          lineTotal: calculateLineTotal(price.unitPrice, item.quantity),
        };
      } catch {
        throw new RpcException({
          code: status.FAILED_PRECONDITION,
          message: 'The catalog returned an invalid product price',
        });
      }
    });

    const subtotalMinor = preparedItems.reduce(
      (total, item) => total + parseMoney(item.lineTotal),
      0n,
    );

    let subtotalAmount: string;
    try {
      subtotalAmount = formatMoney(subtotalMinor);
    } catch {
      throw new RpcException({
        code: status.OUT_OF_RANGE,
        message: 'Order total exceeds the supported monetary range',
      });
    }

    try {
      const persistedOrder = await this.dataSource.transaction(
        async (manager) => {
          const orderRepository = manager.getRepository(OrderEntity);
          const itemRepository = manager.getRepository(OrderItemEntity);
          const outboxRepository = manager.getRepository(OutboxEventEntity);

          const order = orderRepository.create({
            id: orderId,
            customerId: authenticatedCustomerId,
            idempotencyKey: request.idempotencyKey,
            requestHash,
            status: OrderStatus.RESERVING_INVENTORY,
            currency,
            subtotalAmount,
            totalAmount: subtotalAmount,
            version: 1,
          });

          const savedOrder = await orderRepository.save(order);
          const eventId = randomUUID();
          await OrderStatusHistoryService.recordInitial(manager, savedOrder, {
            reasonCode: 'ORDER_CREATED',
            reason: 'Order created',
            correlationId: eventId,
            causationId: null,
          });

          const orderItems = preparedItems.map((item) =>
            itemRepository.create({
              id: randomUUID(),
              order: savedOrder,
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              lineTotal: item.lineTotal,
            }),
          );

          await itemRepository.save(orderItems);
          // The event and snapshot rows commit atomically with the saved order.
          // The event and snapshot rows commit atomically with the saved order.
          await outboxRepository.save(
            outboxRepository.create({
              id: eventId,
              aggregateType: 'Order',
              aggregateId: savedOrder.id,
              eventType: 'order.created.v1',
              payload: {
                eventId,
                eventType: 'order.created.v1',
                eventVersion: 1,
                aggregateId: savedOrder.id,
                occurredAt: new Date().toISOString(),
                correlationId: eventId,
                causationId: null,
                orderId: savedOrder.id,
                customerId: savedOrder.customerId,
                currency,
                subtotalAmount,
                totalAmount: subtotalAmount,
                items: preparedItems,
              },
              publishedAt: null,
              attempts: 0,
              nextAttemptAt: new Date(),
              lastError: null,
            }),
          );

          await this.sagaInitializer.initialize(
            manager,
            savedOrder.id,
            eventId,
          );

          return savedOrder;
        },
      );

      return {
        orderId: persistedOrder.id,
        status: persistedOrder.status,
      };
    } catch (error) {
      // Only a unique-key violation can represent a concurrent idempotency race.
      if (this.isDuplicateKeyError(error)) {
        let racedOrder: OrderEntity | null;
        try {
          racedOrder = await this.orders.findOne({
            where: {
              customerId: authenticatedCustomerId,
              idempotencyKey: request.idempotencyKey,
            },
          });
        } catch (lookupError) {
          this.logger.error(
            `Failed to resolve idempotency race for order ${orderId}`,
            lookupError instanceof Error
              ? lookupError.stack
              : String(lookupError),
          );
          throw new RpcException({
            code: status.INTERNAL,
            message: 'Order creation failed; no order was confirmed',
          });
        }

        if (racedOrder) {
          this.assertSameRequest(racedOrder, requestHash);
          return {
            orderId: racedOrder.id,
            status: racedOrder.status,
          };
        }
      }

      this.logger.error(
        `Order transaction failed for order ${orderId}`,
        error instanceof Error ? error.stack : String(error),
      );

      throw new RpcException({
        code: status.INTERNAL,
        message: 'Order creation failed; no order was confirmed',
      });
    }
  }

  async getOrder(
    request: GetOrderRequest,
    customerId: string,
    correlationId: string | null = null,
  ): Promise<GetOrderResponse> {
    const orderId = request.orderId?.trim();

    if (!orderId) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'orderId is required',
      });
    }

    this.validateCustomerId(customerId);

    return this.measureQuery('get', orderId, correlationId, async () => {
      const order = await this.orderQueries.findCustomerOrder(
        orderId,
        customerId,
      );
      if (!order) this.throwNotFound();

      return {
        orderId: order.id,
        customerId: order.customerId,
        status: order.status,
        currency: order.currency,
        subtotalAmount: order.subtotalAmount,
        totalAmount: order.totalAmount,
        items: order.items.map((item) => ({
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
        })),
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
      };
    });
  }

  async getCustomerOrders(
    request: GetCustomerOrdersRequest,
    customerId: string,
    correlationId: string | null = null,
  ): Promise<GetCustomerOrdersResponse> {
    this.validateCustomerId(customerId);
    const page = request.page > 0 ? request.page : 1;
    const limit = request.limit > 0 ? request.limit : DEFAULT_PAGE_SIZE;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > MAX_PAGE_NUMBER ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE
    ) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: `page must be positive and limit must be between 1 and ${MAX_PAGE_SIZE}`,
      });
    }

    const requestedStatus = request.status?.trim();
    if (
      requestedStatus &&
      !Object.values(OrderStatus).includes(requestedStatus as OrderStatus)
    ) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'status is not a supported order status',
      });
    }
    const query: ListOrdersDto = {
      customerId,
      page,
      limit,
      status: requestedStatus ? (requestedStatus as OrderStatus) : null,
    };

    return this.measureQuery('list', null, correlationId, async () => {
      const { rows, total } = await this.orderQueries.findCustomerOrders(query);
      return {
        orders: rows.map((order) => ({
          orderId: order.id,
          status: order.status,
          currency: order.currency,
          totalAmount: order.totalAmount,
          itemCount: order.itemCount ?? 0,
          createdAt: order.createdAt.toISOString(),
          updatedAt: order.updatedAt.toISOString(),
        })),
        pagination: {
          page,
          limit,
          total,
          hasNextPage: page * limit < total,
        },
      };
    });
  }

  async getOrderStatus(
    request: GetOrderStatusRequest,
    customerId: string,
    correlationId: string | null = null,
  ): Promise<GetOrderStatusResponse> {
    const orderId = request.orderId?.trim();
    if (!orderId) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'orderId is required',
      });
    }
    this.validateCustomerId(customerId);

    return this.measureQuery('status', orderId, correlationId, async () => {
      const order = await this.orderQueries.findCustomerOrderShallow(
        orderId,
        customerId,
      );
      if (!order) this.throwNotFound();
      return {
        orderId: order.id,
        status: order.status,
        updatedAt: order.updatedAt.toISOString(),
      };
    });
  }

  async getOrderTimeline(
    request: GetOrderTimelineRequest,
    customerId: string,
    correlationId: string | null = null,
  ): Promise<GetOrderTimelineResponse> {
    const orderId = request.orderId?.trim();
    if (!orderId) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'orderId is required',
      });
    }
    this.validateCustomerId(customerId);

    return this.measureQuery('timeline', orderId, correlationId, async () => {
      const result = await this.orderQueries.findOrderTimeline(
        orderId,
        customerId,
      );
      if (!result) this.throwNotFound();
      return {
        orderId: result.order.id,
        currentStatus: result.order.status,
        entries: result.history.map((entry) => ({
          fromStatus: entry.fromStatus ?? '',
          toStatus: entry.toStatus,
          occurredAt: entry.occurredAt.toISOString(),
          reason: entry.reason ?? '',
          reasonCode: entry.reasonCode ?? '',
        })),
      };
    });
  }

  private validateCustomerId(customerId: string): void {
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
  }

  private throwNotFound(): never {
    throw new RpcException({
      code: status.NOT_FOUND,
      message: 'Order not found',
    });
  }

  private async measureQuery<T>(
    operation: 'get' | 'list' | 'status' | 'timeline',
    orderId: string | null,
    correlationId: string | null,
    action: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await action();
      this.queryMetrics.recordSuccess(operation, Date.now() - startedAt);
      this.logger.log(
        JSON.stringify({
          event: 'order.query.completed',
          operation,
          orderId,
          correlationId,
          durationMs: Date.now() - startedAt,
        }),
      );
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const code =
        error instanceof RpcException
          ? (error.getError() as { code?: number }).code
          : undefined;
      this.queryMetrics.recordError(
        operation,
        durationMs,
        code === status.NOT_FOUND,
      );
      if (error instanceof RpcException) throw error;

      this.logger.error(
        JSON.stringify({
          event: 'order.query.failed',
          operation,
          orderId,
          correlationId,
          durationMs,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      throw new RpcException({
        code: status.INTERNAL,
        message: 'Order query failed',
      });
    }
  }

  private validateRequest(request: CreateOrderRequest): void {
    if (
      !request ||
      typeof request.idempotencyKey !== 'string' ||
      !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)
    ) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'A valid idempotency key of 16–128 characters is required',
      });
    }

    if (
      !Array.isArray(request.items) ||
      request.items.length < 1 ||
      request.items.length > MAX_ITEMS
    ) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: `An order must contain between 1 and ${MAX_ITEMS} items`,
      });
    }

    const productIds = new Set<string>();

    for (const item of request.items) {
      if (
        !item ||
        typeof item.productId !== 'string' ||
        !item.productId.trim() ||
        item.productId.length > 64 ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > MAX_QUANTITY_PER_ITEM
      ) {
        throw new RpcException({
          code: status.INVALID_ARGUMENT,
          message: 'Each item must have a valid product ID and quantity',
        });
      }

      const productId = item.productId.trim();

      if (productIds.has(productId)) {
        throw new RpcException({
          code: status.INVALID_ARGUMENT,
          message: 'Duplicate product IDs are not allowed; combine quantities',
        });
      }

      productIds.add(productId);
    }
  }

  private assertSameRequest(existing: OrderEntity, requestHash: string): void {
    // Legacy orders may not have a request fingerprint. Do not claim that
    // their original request has been verified.
    if (!existing.requestHash || existing.requestHash !== requestHash) {
      throw new RpcException({
        code: status.ALREADY_EXISTS,
        message: 'Idempotency key was already used for a different request',
      });
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const databaseError = error as DatabaseError;
    return (
      databaseError.code === 'ER_DUP_ENTRY' ||
      databaseError.driverError?.code === 'ER_DUP_ENTRY'
    );
  }
}
