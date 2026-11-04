import {
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import {
  ChannelCredentials,
  Client,
  Metadata,
  loadPackageDefinition,
  status,
} from '@grpc/grpc-js';
import type { OnModuleDestroy } from '@nestjs/common';
import type {
  ClientUnaryCall,
  GrpcObject,
  ServiceClientConstructor,
  ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OrderQueryMetricsService } from './order-query-metrics.service';
import type {
  GetCustomerOrdersRequest,
  GetCustomerOrdersResponse,
  GetOrderRequest,
  GetOrderResponse,
  GetOrderStatusRequest,
  GetOrderStatusResponse,
  GetOrderTimelineRequest,
  GetOrderTimelineResponse,
} from 'default/contracts';

interface UnaryMethod<TRequest, TResponse> {
  (
    request: TRequest,
    metadata: Metadata,
    options: { deadline: Date },
    callback: (error: ServiceError | null, response?: TResponse) => void,
  ): ClientUnaryCall;
}

interface OrderServiceRpcClient extends Client {
  getOrder: UnaryMethod<GetOrderRequest, GetOrderResponse>;
  getCustomerOrders: UnaryMethod<
    GetCustomerOrdersRequest,
    GetCustomerOrdersResponse
  >;
  getOrderStatus: UnaryMethod<GetOrderStatusRequest, GetOrderStatusResponse>;
  getOrderTimeline: UnaryMethod<
    GetOrderTimelineRequest,
    GetOrderTimelineResponse
  >;
}

function asOrderServiceClient(
  client: InstanceType<ServiceClientConstructor>,
): OrderServiceRpcClient {
  const methods = [
    'getOrder',
    'getCustomerOrders',
    'getOrderStatus',
    'getOrderTimeline',
  ];
  if (methods.some((method) => typeof client[method] !== 'function')) {
    throw new Error('OrderService gRPC client is missing required methods');
  }
  // grpc-js generates these method signatures from the proto at runtime.
  return client as unknown as OrderServiceRpcClient;
}

const RPC_TIMEOUT_MS = 3000;
const MAX_READ_ATTEMPTS = 2;

@Injectable()
export class OrdersGrpcClient implements OnModuleDestroy {
  private readonly logger = new Logger(OrdersGrpcClient.name);
  private client: OrderServiceRpcClient | undefined;

  constructor(private readonly metrics: OrderQueryMetricsService) {
    const protoCandidates = [
      join(
        process.cwd(),
        'dist',
        'apps',
        'api-gateway',
        'proto',
        'order.proto',
      ),
      join(
        process.cwd(),
        'dist',
        'libs',
        'contracts',
        'src',
        'proto',
        'order.proto',
      ),
      join(
        process.cwd(),
        'dist',
        'apps',
        'order-service',
        'proto',
        'order.proto',
      ),
      join(process.cwd(), 'libs', 'contracts', 'src', 'proto', 'order.proto'),
    ];
    const protoPath = protoCandidates.find((candidate) =>
      existsSync(candidate),
    );
    if (!protoPath) {
      throw new Error(
        `Order gRPC proto not found; checked ${protoCandidates.join(', ')}`,
      );
    }
    const definition = loadSync(protoPath, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const loaded = loadPackageDefinition(definition) as GrpcObject;
    const ecommerce = loaded.ecommerce;
    if (!ecommerce || typeof ecommerce !== 'object') {
      throw new Error('Order gRPC package ecommerce was not loaded');
    }
    const orders = (ecommerce as GrpcObject).orders;
    if (!orders || typeof orders !== 'object') {
      throw new Error('Order gRPC package ecommerce.orders was not loaded');
    }
    const versioned = (orders as GrpcObject).v1;
    if (!versioned || typeof versioned !== 'object') {
      throw new Error('Order gRPC package ecommerce.orders.v1 was not loaded');
    }
    const constructorEntry = (versioned as GrpcObject).OrderService;
    if (typeof constructorEntry !== 'function') {
      throw new Error('OrderService gRPC client was not generated');
    }
    const constructor = constructorEntry as ServiceClientConstructor;
    const address = process.env.ORDER_GRPC_URL ?? '127.0.0.1:50051';
    this.client = asOrderServiceClient(
      new constructor(address, ChannelCredentials.createInsecure()),
    );
  }

  onModuleDestroy(): void {
    this.client?.close();
    this.client = undefined;
  }

  getOrder(
    orderId: string,
    customerId: string,
    correlationId: string,
  ): Promise<GetOrderResponse> {
    return this.invoke(
      'get',
      'GetOrder',
      (client, metadata, callback, options) =>
        client.getOrder({ orderId, customerId }, metadata, options, callback),
      correlationId,
      customerId,
    );
  }

  getCustomerOrders(
    request: GetCustomerOrdersRequest,
    correlationId: string,
  ): Promise<GetCustomerOrdersResponse> {
    return this.invoke(
      'list',
      'GetCustomerOrders',
      (client, metadata, callback, options) =>
        client.getCustomerOrders(request, metadata, options, callback),
      correlationId,
      request.customerId,
    );
  }

  getOrderStatus(
    orderId: string,
    customerId: string,
    correlationId: string,
  ): Promise<GetOrderStatusResponse> {
    return this.invoke(
      'status',
      'GetOrderStatus',
      (client, metadata, callback, options) =>
        client.getOrderStatus(
          { orderId, customerId },
          metadata,
          options,
          callback,
        ),
      correlationId,
      customerId,
    );
  }

  getOrderTimeline(
    orderId: string,
    customerId: string,
    correlationId: string,
  ): Promise<GetOrderTimelineResponse> {
    return this.invoke(
      'timeline',
      'GetOrderTimeline',
      (client, metadata, callback, options) =>
        client.getOrderTimeline(
          { orderId, customerId },
          metadata,
          options,
          callback,
        ),
      correlationId,
      customerId,
    );
  }

  private async invoke<T>(
    operation: 'get' | 'list' | 'status' | 'timeline',
    methodName: string,
    call: (
      client: OrderServiceRpcClient,
      metadata: Metadata,
      callback: (error: ServiceError | null, response?: T) => void,
      options: { deadline: Date },
    ) => ClientUnaryCall,
    correlationId: string,
    customerId: string,
  ): Promise<T> {
    const startedAt = Date.now();
    let lastError: ServiceError | undefined;
    for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
      try {
        const client = this.requireClient();
        const response = await new Promise<T>((resolve, reject) => {
          const metadata = new Metadata();
          metadata.set('x-authenticated-customer-id', customerId);
          metadata.set('x-correlation-id', correlationId);
          call(
            client,
            metadata,
            (error, value) => {
              if (error) reject(error);
              else if (value !== undefined) resolve(value);
              else
                reject(new Error('Order Service returned an empty response'));
            },
            { deadline: new Date(Date.now() + RPC_TIMEOUT_MS) },
          );
        });
        this.metrics.recordSuccess(operation, Date.now() - startedAt);
        this.logger.log(
          JSON.stringify({
            event: 'gateway.order_query.completed',
            operation,
            correlationId,
            durationMs: Date.now() - startedAt,
          }),
        );
        return response;
      } catch (error) {
        if (this.isServiceError(error)) {
          lastError = error;
          this.metrics.recordGrpcFailure();
          if (
            error.code === status.UNAVAILABLE &&
            attempt < MAX_READ_ATTEMPTS
          ) {
            await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
            continue;
          }
        }
        break;
      }
    }

    const durationMs = Date.now() - startedAt;
    this.metrics.recordError(
      operation,
      durationMs,
      lastError?.code === status.NOT_FOUND,
    );
    this.logger.error(
      JSON.stringify({
        event: 'gateway.order_query.failed',
        operation,
        correlationId,
        durationMs,
        grpcStatus: lastError?.code ?? 'UNKNOWN',
      }),
    );
    this.throwHttpError(lastError);
  }

  private requireClient(): OrderServiceRpcClient {
    if (!this.client) throw new Error('Order gRPC client is not initialized');
    return this.client;
  }

  private isServiceError(error: unknown): error is ServiceError {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'number'
    );
  }

  private throwHttpError(error: ServiceError | undefined): never {
    switch (error?.code) {
      case status.NOT_FOUND:
        throw new NotFoundException('Order not found');
      case status.INVALID_ARGUMENT:
        throw new BadRequestException('Invalid order query');
      case status.UNAUTHENTICATED:
        throw new UnauthorizedException('Authentication is required');
      case status.PERMISSION_DENIED:
        throw new ForbiddenException('Access to this order is denied');
      case status.UNAVAILABLE:
        throw new ServiceUnavailableException(
          'Order service is temporarily unavailable',
        );
      case status.DEADLINE_EXCEEDED:
        throw new GatewayTimeoutException(
          'Order service did not respond in time',
        );
      default:
        throw new InternalServerErrorException(
          'Unable to retrieve order information',
        );
    }
  }
}
