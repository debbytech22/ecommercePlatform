import { Metadata, status } from '@grpc/grpc-js';
import {
  ClientProxyFactory,
  RpcException,
  Transport,
} from '@nestjs/microservices';
import type { ClientGrpc } from '@nestjs/microservices';
import type { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import type { Repository } from 'typeorm';
import * as amqp from 'amqplib';

import type { CreateOrderRequest } from 'default/contracts';

import { CatalogServiceModule } from '../../catalog-service/src/catalog-service.module';
import { ProductEntity } from '../../catalog-service/src/product.entity';
import { getCatalogDatabaseOptions } from '../../catalog-service/src/config/database-options';
import { OrderEntity } from '../src/entities/order.entity';
import { OrderItemEntity } from '../src/entities/order-item.entity';
import { OutboxEventEntity } from '../src/entities/outbox-event.entity';
import { getDatabaseOptions } from '../src/config/database-options';
import { OrderGrpcController } from '../src/order-service.controller';
import { OrderServiceService } from '../src/order-service.service';
import { ProductPricingGrpcClient } from '../src/pricing/product-pricing.grpc';
import { OutboxRepository } from '../src/outbox/outbox.repository';
import { OutboxPublisherService } from '../src/outbox/outbox-publisher.service';
import { RabbitMqConnection } from '../src/outbox/rabbitmq/rabbitmq.connection';
import { RabbitMqPublisher } from '../src/outbox/rabbitmq/rabbitmq.publisher';

const SERVICE_TOKEN = 'order-integration-test-token';
const CUSTOMER_ID = `integration-customer-${process.pid}`;
const PRODUCT_PREFIX = `integration-${process.pid}-`;
const CONCURRENT_INSERT_TRIGGER = `trg_order_integration_concurrent_${process.pid}`;
const OUTBOX_FAILURE_TRIGGER = `trg_order_integration_outbox_${process.pid}`;
const PROTO_PATH = join(
  process.cwd(),
  'libs',
  'contracts',
  'src',
  'proto',
  'catalog.proto',
);

describe('Order creation integration', () => {
  let orderDataSource: DataSource;
  let catalogDataSource: DataSource;
  let catalogApp: INestMicroservice;
  let catalogClient: ClientGrpc;
  let controller: OrderGrpcController;
  let orders: Repository<OrderEntity>;
  let orderItems: Repository<OrderItemEntity>;
  let outboxEvents: Repository<OutboxEventEntity>;
  let port: number;
  let catalogAppClosed = false;

  beforeAll(async () => {
    const orderDatabaseName = requireTestDatabase(
      'ORDER_TEST_DB_NAME',
      'ORDER_DB_NAME',
    );
    const catalogDatabaseName = requireTestDatabase(
      'CATALOG_TEST_DB_NAME',
      'CATALOG_DB_NAME',
    );
    const rabbitMqUrl = process.env.RABBITMQ_TEST_URL;
    if (!rabbitMqUrl) {
      throw new Error(
        'RABBITMQ_TEST_URL must point to a dedicated RabbitMQ test vhost',
      );
    }

    process.env.ORDER_DB_NAME = orderDatabaseName;
    process.env.CATALOG_DB_NAME = catalogDatabaseName;
    process.env.CATALOG_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.RABBITMQ_URL = rabbitMqUrl;

    port = await getAvailablePort();
    process.env.CATALOG_GRPC_BIND_URL = `127.0.0.1:${port}`;

    orderDataSource = new DataSource(
      withModuleDirname(
        join(process.cwd(), 'apps', 'order-service', 'src', 'config'),
        () => getDatabaseOptions(process.env),
      ),
    );
    catalogDataSource = new DataSource(
      withModuleDirname(
        join(process.cwd(), 'apps', 'catalog-service', 'src', 'config'),
        () => getCatalogDatabaseOptions(process.env),
      ),
    );
    await orderDataSource.initialize();
    await catalogDataSource.initialize();
    await orderDataSource.runMigrations();
    await catalogDataSource.runMigrations();

    await clearIntegrationRows();

    catalogApp = await withModuleDirnameAsync(
      join(process.cwd(), 'apps', 'catalog-service', 'src', 'config'),
      () =>
        NestFactory.createMicroservice(CatalogServiceModule, {
          transport: Transport.GRPC,
          options: {
            package: 'ecommerce.catalog.v1',
            protoPath: PROTO_PATH,
            url: `127.0.0.1:${port}`,
          },
        }),
    );
    await catalogApp.listen();

    catalogClient = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        package: 'ecommerce.catalog.v1',
        protoPath: PROTO_PATH,
        url: `127.0.0.1:${port}`,
      },
    }) as ClientGrpc;

    const pricing = new ProductPricingGrpcClient(
      catalogClient,
      new ConfigService({ CATALOG_SERVICE_TOKEN: SERVICE_TOKEN }),
    );
    pricing.onModuleInit();

    const orderService = new OrderServiceService(
      orderDataSource,
      orderDataSource.getRepository(OrderEntity),
      pricing,
    );
    controller = new OrderGrpcController(orderService);
    orders = orderDataSource.getRepository(OrderEntity);
    orderItems = orderDataSource.getRepository(OrderItemEntity);
    outboxEvents = orderDataSource.getRepository(OutboxEventEntity);
  }, 30000);

  afterAll(async () => {
    catalogClient?.close();
    if (catalogApp && !catalogAppClosed) {
      await catalogApp.close();
    }
    if (orderDataSource?.isInitialized) {
      await clearOrderRows();
      await orderDataSource.destroy();
    }
    if (catalogDataSource?.isInitialized) {
      await catalogDataSource
        .getRepository(ProductEntity)
        .createQueryBuilder()
        .delete()
        .where('product_id LIKE :prefix', { prefix: `${PRODUCT_PREFIX}%` })
        .execute();
      await catalogDataSource.destroy();
    }
  });

  it('creates an order, handles idempotent retries, rejects changed contents, and serializes concurrent duplicates', async () => {
    const productId = `${PRODUCT_PREFIX}success`;
    await createProduct(productId, true);

    const request = makeRequest('key-success-00001', productId);
    const first = await createOrder(request);
    expect(first.orderId).toBeTruthy();
    expect(first.status).toBe('RESERVING_INVENTORY');

    const retry = await createOrder(request);
    expect(retry).toEqual(first);

    await expectRpcStatus(
      createOrder({
        ...request,
        items: [{ productId, quantity: 3 }],
      }),
      status.ALREADY_EXISTS,
    );

    const concurrentRequest = makeRequest('key-concurrent-0001', productId);
    await orderDataSource.query(
      `CREATE TRIGGER \`${CONCURRENT_INSERT_TRIGGER}\` BEFORE INSERT ON \`orders\` FOR EACH ROW DO SLEEP(0.5)`,
    );
    try {
      const [concurrentFirst, concurrentSecond] = await Promise.all([
        createOrder(concurrentRequest),
        createOrder(concurrentRequest),
      ]);
      expect(concurrentFirst).toEqual(concurrentSecond);
    } finally {
      await orderDataSource.query(
        `DROP TRIGGER IF EXISTS \`${CONCURRENT_INSERT_TRIGGER}\``,
      );
    }

    const persistedOrder = await orders.findOneByOrFail({
      id: first.orderId,
    });
    expect(persistedOrder.customerId).toBe(CUSTOMER_ID);
    expect(persistedOrder.requestHash).toMatch(/^[a-f0-9]{64}$/);

    const persistedItems = await orderItems.findBy({
      order: { id: first.orderId },
    });
    expect(persistedItems).toHaveLength(1);
    expect(persistedItems[0].lineTotal).toBe('2.5000');

    const persistedEvents = await outboxEvents.findBy({
      aggregateId: first.orderId,
    });
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0].id).toBe(persistedEvents[0].payload.eventId);
    expect(persistedEvents[0].payload.orderId).toBe(first.orderId);

    await publishPendingEventsToRabbit(persistedEvents);
  });

  it('rejects invalid/inactive products, rolls back a failed transaction, and handles Catalog unavailability', async () => {
    const inactiveProductId = `${PRODUCT_PREFIX}inactive`;
    await createProduct(inactiveProductId, false);

    await expectRpcStatus(
      createOrder(makeRequest('key-missing-00001', `${PRODUCT_PREFIX}missing`)),
      status.FAILED_PRECONDITION,
    );
    await expectRpcStatus(
      createOrder(makeRequest('key-inactive-00001', inactiveProductId)),
      status.FAILED_PRECONDITION,
    );

    const rollbackProductId = `${PRODUCT_PREFIX}rollback`;
    await createProduct(rollbackProductId, true);
    const rollbackRequest = makeRequest('key-rollback-0001', rollbackProductId);
    await orderDataSource.query(
      `CREATE TRIGGER \`${OUTBOX_FAILURE_TRIGGER}\` BEFORE INSERT ON \`outbox_events\` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'integration transaction failure'`,
    );
    try {
      const itemCountBefore = await orderItems.count();
      const outboxCountBefore = await outboxEvents.count();
      await expectRpcStatus(createOrder(rollbackRequest), status.INTERNAL);
      expect(
        await orders.findOneBy({
          customerId: CUSTOMER_ID,
          idempotencyKey: rollbackRequest.idempotencyKey,
        }),
      ).toBeNull();
      expect(await orderItems.count()).toBe(itemCountBefore);
      expect(await outboxEvents.count()).toBe(outboxCountBefore);
    } finally {
      await orderDataSource.query(
        `DROP TRIGGER IF EXISTS \`${OUTBOX_FAILURE_TRIGGER}\``,
      );
    }

    await catalogApp.close();
    catalogAppClosed = true;
    await expectRpcStatus(
      createOrder(makeRequest('key-unavailable-001', rollbackProductId)),
      status.UNAVAILABLE,
    );
  });

  async function createProduct(
    productId: string,
    active: boolean,
  ): Promise<void> {
    await catalogDataSource.getRepository(ProductEntity).save(
      catalogDataSource.getRepository(ProductEntity).create({
        productId,
        productName: `Integration product ${productId}`,
        unitPrice: '1.2500',
        currency: 'USD',
        active,
      }),
    );
  }

  function makeRequest(
    idempotencyKey: string,
    productId: string,
  ): CreateOrderRequest {
    return {
      customerId: 'untrusted-request-customer',
      idempotencyKey,
      items: [{ productId, quantity: 2 }],
    };
  }

  function createOrder(request: CreateOrderRequest) {
    const metadata = new Metadata();
    metadata.set('x-authenticated-customer-id', CUSTOMER_ID);
    return controller.createOrder(request, metadata);
  }

  async function clearIntegrationRows(): Promise<void> {
    await clearOrderRows();
    await catalogDataSource
      .getRepository(ProductEntity)
      .createQueryBuilder()
      .delete()
      .where('product_id LIKE :prefix', { prefix: `${PRODUCT_PREFIX}%` })
      .execute();
  }

  async function clearOrderRows(): Promise<void> {
    await orderDataSource.query(
      'DELETE FROM `outbox_events` WHERE `aggregate_id` IN (SELECT `id` FROM `orders` WHERE `customer_id` = ?)',
      [CUSTOMER_ID],
    );
    await orderDataSource.query(
      'DELETE FROM `order_item_entity` WHERE `order_id` IN (SELECT `id` FROM `orders` WHERE `customer_id` = ?)',
      [CUSTOMER_ID],
    );
    await orderDataSource.query(
      'DELETE FROM `orders` WHERE `customer_id` = ?',
      [CUSTOMER_ID],
    );
  }

  async function publishPendingEventsToRabbit(
    pendingEvents: OutboxEventEntity[],
  ): Promise<void> {
    const rabbitUrl = process.env.RABBITMQ_URL!;
    const exchangeName =
      process.env.RABBITMQ_ORDERS_EXCHANGE ?? 'ecommerce.events';
    const consumerConnection = await amqp.connect(rabbitUrl);
    const consumerChannel = await consumerConnection.createChannel();
    const queueName = `order-outbox-integration-${process.pid}`;

    try {
      await consumerChannel.assertExchange(exchangeName, 'topic', {
        durable: true,
      });
      await consumerChannel.assertQueue(queueName, {
        durable: false,
        exclusive: true,
        autoDelete: true,
      });
      await consumerChannel.bindQueue(
        queueName,
        exchangeName,
        'order.created.v1',
      );

      const rabbitMqConnection = new RabbitMqConnection(
        new ConfigService({
          RABBITMQ_URL: rabbitUrl,
          RABBITMQ_ORDERS_EXCHANGE: exchangeName,
        }),
      );
      rabbitMqConnection.onModuleInit();

      try {
        await waitForRabbitChannel(rabbitMqConnection);
        const outboxPublisher = new OutboxPublisherService(
          new OutboxRepository(orderDataSource),
          new RabbitMqPublisher(
            rabbitMqConnection,
            new ConfigService({
              RABBITMQ_ORDERS_EXCHANGE: exchangeName,
              RABBITMQ_CONFIRM_TIMEOUT_MS: '5000',
            }),
          ),
          new ConfigService({ OUTBOX_BATCH_SIZE: '25' }),
        );

        await outboxPublisher.poll();
        await outboxPublisher.onModuleDestroy();
      } finally {
        await rabbitMqConnection.onModuleDestroy();
      }

      const messages: amqp.GetMessage[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        const message = await consumerChannel.get(queueName, {
          noAck: true,
        });
        if (message) {
          messages.push(message);
        }
        if (messages.length >= pendingEvents.length) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(messages.map((message) => message.properties.messageId)).toEqual(
        expect.arrayContaining(pendingEvents.map(({ id }) => id)),
      );
      const eventEnvelope = JSON.parse(messages[0].content.toString('utf8'));
      expect(eventEnvelope).toMatchObject({
        eventId: messages[0].properties.messageId,
        eventType: 'order.created.v1',
        eventVersion: 1,
        aggregateId: pendingEvents[0].aggregateId,
        correlationId: messages[0].properties.messageId,
        causationId: null,
      });
      const reloadedEvents = await outboxEvents.findBy({
        aggregateId: pendingEvents[0].aggregateId,
      });
      expect(reloadedEvents.every((event) => event.publishedAt !== null)).toBe(
        true,
      );
    } finally {
      await consumerChannel.close();
      await consumerConnection.close();
    }
  }
});

function requireTestDatabase(
  testVariable: string,
  configuredVariable: string,
): string {
  const databaseName = process.env[testVariable];
  if (!databaseName || !databaseName.endsWith('_test')) {
    throw new Error(
      `${testVariable} must be set to a dedicated database name ending in "_test"`,
    );
  }

  if (databaseName === process.env[configuredVariable]) {
    throw new Error(
      `${testVariable} must not target the configured non-test database`,
    );
  }

  return databaseName;
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a local gRPC port');
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForRabbitChannel(
  connection: RabbitMqConnection,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      connection.getConfirmChannel();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('RabbitMQ publisher did not connect within 10 seconds');
}

function withModuleDirname<T>(directory: string, operation: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__dirname');
  Object.defineProperty(globalThis, '__dirname', {
    configurable: true,
    value: directory,
  });

  try {
    return operation();
  } finally {
    restoreModuleDirname(previous);
  }
}

async function withModuleDirnameAsync<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__dirname');
  Object.defineProperty(globalThis, '__dirname', {
    configurable: true,
    value: directory,
  });

  try {
    return await operation();
  } finally {
    restoreModuleDirname(previous);
  }
}

function restoreModuleDirname(previous: PropertyDescriptor | undefined): void {
  if (previous) {
    Object.defineProperty(globalThis, '__dirname', previous);
  } else {
    Reflect.deleteProperty(globalThis, '__dirname');
  }
}

async function expectRpcStatus(
  promise: Promise<unknown>,
  expectedStatus: number,
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected the operation to reject');
  } catch (error) {
    const response = error instanceof RpcException ? error.getError() : error;
    expect(response).toMatchObject({ code: expectedStatus });
  }
}
