import { randomUUID } from 'node:crypto';
import * as amqp from 'amqplib';
import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { jest } from '@jest/globals';

import type { OrderCreatedEvent } from 'default/contracts';
import { InboxEventEntity } from '../src/inbox/entities/inbox-event.entity';
import { InboxService } from '../src/inbox/inbox.service';
import { ProductInventoryEntity } from '../src/inventory/entities/product-inventory.entity';
import { InventoryReservationItemEntity } from '../src/reservations/entities/inventory-reservation-item.entity';
import { InventoryEventPublisher } from '../src/messaging/publishers/inventory-event.publisher';
import { OrderCreatedConsumer } from '../src/messaging/consumers/order-created.consumer';
import { RabbitMqConsumer } from '../src/messaging/rabbitmq/rabbitmq.consumer';
import { RabbitMqPublisherChannel } from '../src/messaging/rabbitmq/rabbitmq.publisher-channel';
import { InventoryMetricsService } from '../src/observability/inventory-metrics.service';
import { OutboxEventEntity } from '../src/outbox/entities/outbox-event.entity';
import { OutboxPublisherService } from '../src/outbox/outbox-publisher.service';
import { OutboxRepository } from '../src/outbox/outbox.repository';
import {
  InventoryReservationEntity,
  InventoryReservationStatus,
} from '../src/reservations/entities/inventory-reservation.entity';
import { ReservationsService } from '../src/reservations/reservations.service';

jest.setTimeout(120_000);

const integrationEnabled = process.env.INVENTORY_INTEGRATION_TEST === 'true';
const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration('Inventory Phase 3 real RabbitMQ/MySQL integration', () => {
  const runId = randomUUID();
  const productPrefix = `it-${runId.slice(0, 8)}-`;
  const productIds = {
    duplicate: `${productPrefix}duplicate`,
    concurrent: `${productPrefix}concurrent`,
  };
  const eventIds: string[] = [];
  const orderIds: string[] = [];
  let dataSource: DataSource;
  let publisherChannel: RabbitMqPublisherChannel;
  let consumer: RabbitMqConsumer;
  let testChannel: amqp.ConfirmChannel;
  let resultQueue: string;
  let reservations: ReservationsService;
  let metrics: InventoryMetricsService;

  function makeOrderEvent(
    orderId: string,
    productId: string,
    quantity: number,
  ): OrderCreatedEvent {
    const eventId = randomUUID();
    eventIds.push(eventId);
    orderIds.push(orderId);
    return {
      eventId,
      eventType: 'order.created.v1',
      eventVersion: 1,
      aggregateId: orderId,
      occurredAt: new Date().toISOString(),
      correlationId: runId,
      causationId: null,
      payload: {
        orderId,
        customerId: 'inventory-integration-customer',
        currency: 'USD',
        subtotalAmount: `${quantity.toFixed(4)}`,
        totalAmount: `${quantity.toFixed(4)}`,
        items: [
          {
            productId,
            productName: 'Integration test product',
            quantity,
            unitPrice: '1.0000',
            lineTotal: `${quantity.toFixed(4)}`,
          },
        ],
      },
    };
  }

  async function publishInput(event: OrderCreatedEvent): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      testChannel.publish(
        'ecommerce.events',
        'order.created.v1',
        Buffer.from(JSON.stringify(event)),
        {
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          messageId: event.eventId,
          correlationId: event.correlationId,
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  async function waitFor(
    description: string,
    condition: () => Promise<boolean>,
  ): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  async function waitForProcessed(eventIdsToWait: string[]): Promise<void> {
    await waitFor('inbox events to become processed', async () => {
      const count = await dataSource.getRepository(InboxEventEntity).count({
        where: eventIdsToWait.map((eventId) => ({
          eventId,
          status: 'PROCESSED',
        })),
      });
      return count === eventIdsToWait.length;
    });
  }

  async function cleanupRows(): Promise<void> {
    if (!dataSource?.isInitialized || orderIds.length === 0) {
      return;
    }
    const placeholders = orderIds.map(() => '?').join(', ');
    await dataSource.query(
      `DELETE FROM \`outbox_events\` WHERE \`aggregate_id\` IN (${placeholders})`,
      orderIds,
    );
    await dataSource.query(
      `DELETE FROM \`inventory_reservations\` WHERE \`order_id\` IN (${placeholders})`,
      orderIds,
    );
    if (eventIds.length > 0) {
      const eventPlaceholders = eventIds.map(() => '?').join(', ');
      await dataSource.query(
        `DELETE FROM \`inbox_events\` WHERE \`event_id\` IN (${eventPlaceholders})`,
        eventIds,
      );
    }
    const productPlaceholders = Object.keys(productIds)
      .map(() => '?')
      .join(', ');
    await dataSource.query(
      `DELETE FROM \`product_inventory\` WHERE \`product_id\` IN (${productPlaceholders})`,
      Object.values(productIds),
    );
  }

  beforeAll(async () => {
    const databaseName = process.env.INVENTORY_DB_NAME;
    const rabbitUrl = process.env.RABBITMQ_URL;
    if (!databaseName?.endsWith('_test')) {
      throw new Error(
        'INVENTORY_DB_NAME must end with _test for this integration suite',
      );
    }
    if (!rabbitUrl) {
      throw new Error('RABBITMQ_URL must point to a dedicated test broker');
    }

    const required = (key: string): string => {
      const value = process.env[key];
      if (!value) {
        throw new Error(
          `${key} is required for the Inventory integration test`,
        );
      }
      return value;
    };
    const databasePort = Number(required('INVENTORY_DB_PORT'));
    if (
      !Number.isInteger(databasePort) ||
      databasePort < 1 ||
      databasePort > 65535
    ) {
      throw new Error(
        'INVENTORY_DB_PORT must be an integer between 1 and 65535',
      );
    }
    dataSource = new DataSource({
      type: 'mysql',
      host: required('INVENTORY_DB_HOST'),
      port: databasePort,
      username: required('INVENTORY_DB_USER'),
      password: required('INVENTORY_DB_PASSWORD'),
      database: databaseName,
      entities: [
        ProductInventoryEntity,
        InventoryReservationEntity,
        InventoryReservationItemEntity,
        InboxEventEntity,
        OutboxEventEntity,
      ],
      synchronize: false,
      migrationsRun: false,
      extra: { connectionLimit: 10 },
    });
    await dataSource.initialize();

    metrics = new InventoryMetricsService();
    reservations = new ReservationsService(dataSource);
    const inbox = new InboxService(dataSource);
    const orderConsumer = new OrderCreatedConsumer(
      inbox,
      reservations,
      metrics,
    );
    const config = {
      get: (name: string, defaultValue?: string) =>
        name === 'RABBITMQ_URL' ? rabbitUrl : defaultValue,
    } as ConfigService;
    publisherChannel = new RabbitMqPublisherChannel(config, metrics);
    publisherChannel.onModuleInit();
    await waitFor('publisher confirm channel', async () => {
      try {
        publisherChannel.getConfirmChannel();
        return true;
      } catch {
        return false;
      }
    });

    consumer = new RabbitMqConsumer(
      config,
      orderConsumer,
      publisherChannel,
      metrics,
    );
    consumer.onModuleInit();
    await waitFor('Inventory RabbitMQ consumer connection', async () =>
      metrics
        .renderPrometheus()
        .includes('inventory_rabbitmq_connected{component="consumer"} 1'),
    );
    testChannel = publisherChannel.getConfirmChannel();

    await testChannel.assertExchange('ecommerce.events', 'topic', {
      durable: true,
    });
    const queue = await testChannel.assertQueue('', {
      exclusive: true,
      autoDelete: true,
    });
    resultQueue = queue.queue;

    await dataSource.getRepository(ProductInventoryEntity).save([
      dataSource.getRepository(ProductInventoryEntity).create({
        productId: productIds.duplicate,
        onHand: 10,
        reserved: 0,
      }),
      dataSource.getRepository(ProductInventoryEntity).create({
        productId: productIds.concurrent,
        onHand: 5,
        reserved: 0,
      }),
    ]);
  });

  afterAll(async () => {
    if (testChannel && resultQueue) {
      await testChannel.deleteQueue(resultQueue).catch(() => undefined);
    }
    await consumer?.onModuleDestroy();
    await publisherChannel?.onModuleDestroy();
    await cleanupRows();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('handles real deliveries, duplicate and concurrent orders, outbox retry/confirm, and idempotent release', async () => {
    const duplicateOrderId = randomUUID();
    const duplicateEvent = makeOrderEvent(
      duplicateOrderId,
      productIds.duplicate,
      3,
    );
    await Promise.all([
      publishInput(duplicateEvent),
      publishInput(duplicateEvent),
    ]);
    await waitForProcessed([duplicateEvent.eventId]);
    await waitFor('duplicate delivery to be recorded', async () =>
      metrics
        .renderPrometheus()
        .includes('inventory_consumer_events_total{outcome="duplicate"} 1'),
    );

    const duplicateReservationCount = await dataSource
      .getRepository(InventoryReservationEntity)
      .countBy({ orderId: duplicateOrderId });
    expect(duplicateReservationCount).toBe(1);
    expect(
      await dataSource.getRepository(ProductInventoryEntity).findOneByOrFail({
        productId: productIds.duplicate,
      }),
    ).toMatchObject({ onHand: 10, reserved: 3 });

    const concurrentEvents = [
      makeOrderEvent(randomUUID(), productIds.concurrent, 4),
      makeOrderEvent(randomUUID(), productIds.concurrent, 4),
    ];
    await Promise.all(concurrentEvents.map(publishInput));
    await waitForProcessed(concurrentEvents.map(({ eventId }) => eventId));

    const concurrentReservations = await dataSource
      .getRepository(InventoryReservationEntity)
      .findBy(
        concurrentEvents.map(({ payload }) => ({ orderId: payload.orderId })),
      );
    expect(
      concurrentReservations.filter(
        ({ status }) => status === InventoryReservationStatus.RESERVED,
      ),
    ).toHaveLength(1);
    expect(
      concurrentReservations.filter(
        ({ status }) => status === InventoryReservationStatus.FAILED,
      ),
    ).toHaveLength(1);
    expect(
      await dataSource.getRepository(ProductInventoryEntity).findOneByOrFail({
        productId: productIds.concurrent,
      }),
    ).toMatchObject({ onHand: 5, reserved: 4 });

    const successfulReservation = concurrentReservations.find(
      ({ status }) => status === InventoryReservationStatus.RESERVED,
    );
    if (!successfulReservation) {
      throw new Error(
        'Concurrent reservation test produced no successful reservation',
      );
    }

    const outboxRepository = new OutboxRepository(dataSource);
    const eventPublisher = new InventoryEventPublisher(publisherChannel, {
      get: (_name: string, defaultValue?: string) => defaultValue,
    } as ConfigService);
    const outboxService = new OutboxPublisherService(
      outboxRepository,
      eventPublisher,
      {
        get: (_name: string, defaultValue?: string) => defaultValue,
      } as ConfigService,
      metrics,
    );
    const expectedOutboxCount = 3;
    await waitFor('all reservation results to enter outbox', async () => {
      const events = await dataSource.getRepository(OutboxEventEntity).find();
      return (
        events.filter(({ aggregateId }) => orderIds.includes(aggregateId))
          .length >= expectedOutboxCount
      );
    });

    const matchingOutbox = await dataSource
      .getRepository(OutboxEventEntity)
      .find({ where: orderIds.map((aggregateId) => ({ aggregateId })) });
    const failedOnceEventId = matchingOutbox[0]?.id;
    if (!failedOnceEventId) {
      throw new Error('No inventory reservation result event was persisted');
    }
    await outboxService.poll();
    const retryRow = await dataSource
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ id: failedOnceEventId });
    expect(retryRow.attempts).toBe(1);
    expect(retryRow.publishedAt).toBeNull();
    expect(retryRow.lastError).toContain('did not route');
    expect(retryRow.nextAttemptAt.getTime()).toBeLessThan(Date.now() + 10_000);

    await testChannel.bindQueue(
      resultQueue,
      'ecommerce.events',
      'inventory.reserved.v1',
    );
    await testChannel.bindQueue(
      resultQueue,
      'ecommerce.events',
      'inventory.reservation_failed.v1',
    );
    await dataSource.query(
      'UPDATE `outbox_events` SET `next_attempt_at` = UTC_TIMESTAMP(6) WHERE `aggregate_id` IN (?, ?, ?)',
      orderIds,
    );
    await outboxService.poll();

    const publishedEvents = await dataSource
      .getRepository(OutboxEventEntity)
      .find({ where: orderIds.map((aggregateId) => ({ aggregateId })) });
    expect(publishedEvents).toHaveLength(expectedOutboxCount);
    expect(
      publishedEvents.every(({ publishedAt }) => publishedAt !== null),
    ).toBe(true);

    const brokerEvents: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < expectedOutboxCount + 2; attempt += 1) {
      const delivery = await testChannel.get(resultQueue, { noAck: true });
      if (!delivery) {
        break;
      }
      brokerEvents.push(
        JSON.parse(delivery.content.toString('utf8')) as Record<
          string,
          unknown
        >,
      );
    }
    expect(brokerEvents).toHaveLength(expectedOutboxCount);
    expect(brokerEvents.map(({ eventType }) => eventType)).toEqual(
      expect.arrayContaining([
        'inventory.reserved.v1',
        'inventory.reservation_failed.v1',
      ]),
    );

    await expect(
      reservations.releaseReservation(successfulReservation.id),
    ).resolves.toBe('released');
    await expect(
      reservations.releaseReservation(successfulReservation.id),
    ).resolves.toBe('already-released');
    expect(
      await dataSource.getRepository(ProductInventoryEntity).findOneByOrFail({
        productId: productIds.concurrent,
      }),
    ).toMatchObject({ onHand: 5, reserved: 0 });
    expect(
      await dataSource
        .getRepository(InventoryReservationEntity)
        .findOneByOrFail({ id: successfulReservation.id }),
    ).toMatchObject({ status: InventoryReservationStatus.RELEASED });
  });
});
