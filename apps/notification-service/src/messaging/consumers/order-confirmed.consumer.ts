import { Injectable, Logger } from '@nestjs/common';
import {
  ORDER_CONFIRMED_EVENT_TYPE,
  type OrderConfirmedEvent,
  type OrderConfirmedPayload,
} from 'default/contracts';
import { NotificationChannel, NotificationType } from '../../notifications/notification-status.enum';
import { NotificationsService } from '../../notifications/notifications.service';
import { TemplatesService } from '../../templates/templates.service';
import type { OrderConfirmedEmailData } from '../../templates/email/order-confirmed.template';

@Injectable()
export class OrderConfirmedConsumer {
  private readonly logger = new Logger(OrderConfirmedConsumer.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly templates: TemplatesService,
  ) {}

  async consume(raw: unknown): Promise<void> {
    const event = this.validate(raw);
    const { payload } = event;

    const emailData: OrderConfirmedEmailData = {
      orderId: payload.orderId,
      customerId: payload.customerId,
      amount: payload.amount,
      currency: payload.currency,
      confirmedAt: payload.confirmedAt,
    };
    const rendered = this.templates.render(
      NotificationType.ORDER_CONFIRMED,
      NotificationChannel.EMAIL,
      emailData,
    );

    const result = await this.notifications.createFromEvent({
      eventId: event.eventId,
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      causationId: event.causationId,
      recipientId: payload.customerId,
      recipientAddress: payload.customerId,
      orderId: payload.orderId,
      channel: NotificationChannel.EMAIL,
      type: NotificationType.ORDER_CONFIRMED,
      templateKey: rendered.templateKey,
      subject: rendered.subject,
      body: rendered.body,
    });

    this.logger.log(
      JSON.stringify({
        event: 'notification.order_confirmed.consumed',
        result,
        orderId: payload.orderId,
        correlationId: event.correlationId,
      }),
    );
  }

  private validate(value: unknown): OrderConfirmedEvent {
    if (typeof value !== 'object' || value === null) {
      throw new Error('order.confirmed event is not an object');
    }
    const r = value as Record<string, unknown>;
    if (r.eventType !== ORDER_CONFIRMED_EVENT_TYPE) {
      throw new Error(`Expected eventType ${ORDER_CONFIRMED_EVENT_TYPE}, got ${String(r.eventType)}`);
    }
    if (r.eventVersion !== 1) {
      throw new Error(`Unsupported eventVersion ${String(r.eventVersion)} for ${ORDER_CONFIRMED_EVENT_TYPE}`);
    }
    if (
      typeof r.eventId !== 'string' || !r.eventId ||
      typeof r.aggregateId !== 'string' || !r.aggregateId ||
      typeof r.occurredAt !== 'string' || isNaN(Date.parse(r.occurredAt)) ||
      typeof r.correlationId !== 'string' || !r.correlationId
    ) {
      throw new Error('order.confirmed event has invalid envelope fields');
    }
    const p = r.payload as Record<string, unknown>;
    if (
      typeof p !== 'object' || p === null ||
      typeof p.orderId !== 'string' || !p.orderId ||
      typeof p.customerId !== 'string' || !p.customerId ||
      typeof p.amount !== 'string' || !p.amount ||
      typeof p.currency !== 'string' || !p.currency ||
      typeof p.confirmedAt !== 'string' || isNaN(Date.parse(p.confirmedAt))
    ) {
      throw new Error('order.confirmed event has invalid payload');
    }
    return value as OrderConfirmedEvent;
  }
}
