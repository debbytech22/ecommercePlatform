import { Injectable, Logger } from '@nestjs/common';
import {
  PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE,
  type PaymentAuthorizationFailedEvent,
} from 'default/contracts';
import { NotificationChannel, NotificationType } from '../../notifications/notification-status.enum';
import { NotificationsService } from '../../notifications/notifications.service';
import { TemplatesService } from '../../templates/templates.service';
import type { PaymentFailedSmsData } from '../../templates/sms/payment-failed.template';

@Injectable()
export class PaymentFailedConsumer {
  private readonly logger = new Logger(PaymentFailedConsumer.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly templates: TemplatesService,
  ) {}

  async consume(raw: unknown): Promise<void> {
    const event = this.validate(raw);
    const { payload } = event;

    // Use PaymentFailedSmsData shape — same fields work for both email and SMS templates
    const templateData: PaymentFailedSmsData = {
      orderId: payload.orderId,
      amount: payload.amount,
      currency: payload.currency,
    };
    const rendered = this.templates.render(
      NotificationType.PAYMENT_FAILED,
      NotificationChannel.EMAIL,
      templateData,
    );

    const result = await this.notifications.createFromEvent({
      eventId: event.eventId,
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      causationId: event.causationId,
      // customerId is not on PaymentAuthorizationFailedPayload — use orderId as
      // the recipient key; real resolution would come from a customer lookup service
      recipientId: payload.orderId,
      recipientAddress: payload.orderId,
      orderId: payload.orderId,
      channel: NotificationChannel.EMAIL,
      type: NotificationType.PAYMENT_FAILED,
      templateKey: rendered.templateKey,
      subject: rendered.subject,
      body: rendered.body,
    });

    this.logger.log(
      JSON.stringify({
        event: 'notification.payment_failed.consumed',
        result,
        orderId: payload.orderId,
        correlationId: event.correlationId,
      }),
    );
  }

  private validate(value: unknown): PaymentAuthorizationFailedEvent {
    if (typeof value !== 'object' || value === null) {
      throw new Error('payment.authorization_failed event is not an object');
    }
    const r = value as Record<string, unknown>;
    if (r.eventType !== PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE) {
      throw new Error(
        `Expected eventType ${PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE}, got ${String(r.eventType)}`,
      );
    }
    if (r.eventVersion !== 1) {
      throw new Error(
        `Unsupported eventVersion ${String(r.eventVersion)} for ${PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE}`,
      );
    }
    if (
      typeof r.eventId !== 'string' || !r.eventId ||
      typeof r.aggregateId !== 'string' || !r.aggregateId ||
      typeof r.occurredAt !== 'string' || isNaN(Date.parse(r.occurredAt)) ||
      typeof r.correlationId !== 'string' || !r.correlationId
    ) {
      throw new Error('payment.authorization_failed event has invalid envelope fields');
    }
    const p = r.payload as Record<string, unknown>;
    if (
      typeof p !== 'object' || p === null ||
      typeof p.orderId !== 'string' || !p.orderId ||
      typeof p.amount !== 'string' || !p.amount ||
      typeof p.currency !== 'string' || !p.currency ||
      typeof p.reasonCode !== 'string' || !p.reasonCode
    ) {
      throw new Error('payment.authorization_failed event has invalid payload');
    }
    return value as PaymentAuthorizationFailedEvent;
  }
}
