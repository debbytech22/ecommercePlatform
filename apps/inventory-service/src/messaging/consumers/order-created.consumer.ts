import { Injectable, Logger } from '@nestjs/common';
import type { OrderCreatedEvent } from 'default/contracts';
import {
  InboxService,
  type InboxProcessingResult,
} from '../../inbox/inbox.service';
import { ReservationsService } from '../../reservations/reservations.service';
import { InventoryMetricsService } from '../../observability/inventory-metrics.service';

export class UnprocessableOrderEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnprocessableOrderEventError';
  }
}

@Injectable()
export class OrderCreatedConsumer {
  private readonly logger = new Logger(OrderCreatedConsumer.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly reservations: ReservationsService,
    private readonly metrics: InventoryMetricsService,
  ) {}

  async consume(event: unknown): Promise<InboxProcessingResult> {
    const startedAt = performance.now();
    let orderCreatedEvent: OrderCreatedEvent | undefined;
    try {
      orderCreatedEvent = this.validateEvent(event);
      const result = await this.inbox.processOnce(
        orderCreatedEvent.eventId,
        orderCreatedEvent.eventType,
        (manager) => this.reservations.reserveOrder(orderCreatedEvent, manager),
      );
      this.metrics.recordConsumerOutcome(result);
      this.logger.log(
        JSON.stringify({
          event: 'inventory.order_created.processed',
          result,
          eventId: orderCreatedEvent.eventId,
          eventType: orderCreatedEvent.eventType,
          correlationId: orderCreatedEvent.correlationId,
          causationId: orderCreatedEvent.causationId,
        }),
      );
      return result;
    } catch (error) {
      this.metrics.recordConsumerOutcome('failed');
      this.logger.error(
        JSON.stringify({
          event: 'inventory.order_created.processing_failed',
          eventId: orderCreatedEvent?.eventId ?? null,
          eventType: orderCreatedEvent?.eventType ?? null,
          correlationId: orderCreatedEvent?.correlationId ?? null,
          causationId: orderCreatedEvent?.causationId ?? null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    } finally {
      this.metrics.recordConsumerDuration(
        (performance.now() - startedAt) / 1000,
      );
    }
  }

  private validateEvent(event: unknown): OrderCreatedEvent {
    if (!this.isRecord(event) || !this.isRecord(event.payload)) {
      throw new UnprocessableOrderEventError(
        'Invalid order.created.v1 event envelope or payload',
      );
    }

    const payload = event.payload;
    const items = payload.items;
    if (
      event.eventType !== 'order.created.v1' ||
      event.eventVersion !== 1 ||
      typeof event.eventId !== 'string' ||
      event.eventId.trim().length === 0 ||
      event.eventId.length > 36 ||
      typeof event.aggregateId !== 'string' ||
      event.aggregateId.trim().length === 0 ||
      event.aggregateId.length > 36 ||
      typeof payload.orderId !== 'string' ||
      payload.orderId.trim().length === 0 ||
      payload.orderId.length > 36 ||
      event.aggregateId !== payload.orderId ||
      typeof event.correlationId !== 'string' ||
      event.correlationId.trim().length === 0 ||
      (event.causationId !== null && typeof event.causationId !== 'string') ||
      typeof event.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(event.occurredAt)) ||
      !Array.isArray(items) ||
      items.length === 0 ||
      typeof payload.customerId !== 'string' ||
      payload.customerId.trim().length === 0 ||
      typeof payload.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(payload.currency) ||
      typeof payload.subtotalAmount !== 'string' ||
      !/^\d{1,15}\.\d{4}$/.test(payload.subtotalAmount) ||
      typeof payload.totalAmount !== 'string' ||
      !/^\d{1,15}\.\d{4}$/.test(payload.totalAmount)
    ) {
      throw new UnprocessableOrderEventError(
        'Invalid order.created.v1 event envelope or payload',
      );
    }
    for (const item of items) {
      if (
        !this.isRecord(item) ||
        typeof item.productId !== 'string' ||
        item.productId.trim().length === 0 ||
        item.productId.length > 120 ||
        typeof item.quantity !== 'number' ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 4_294_967_295 ||
        typeof item.productName !== 'string' ||
        item.productName.trim().length === 0 ||
        typeof item.unitPrice !== 'string' ||
        !/^\d{1,15}\.\d{4}$/.test(item.unitPrice) ||
        typeof item.lineTotal !== 'string' ||
        !/^\d{1,15}\.\d{4}$/.test(item.lineTotal)
      ) {
        throw new UnprocessableOrderEventError(
          'Order event contains an invalid order item',
        );
      }
    }
    const productIds = items.map((item) =>
      this.isRecord(item) ? item.productId : undefined,
    );
    if (new Set(productIds).size !== productIds.length) {
      throw new UnprocessableOrderEventError(
        'Order event contains duplicate product IDs',
      );
    }
    return event as unknown as OrderCreatedEvent;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
