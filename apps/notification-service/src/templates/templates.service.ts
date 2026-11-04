import { Injectable } from '@nestjs/common';
import { NotificationChannel, NotificationType } from '../notifications/notification-status.enum';
import * as orderConfirmedEmail from './email/order-confirmed.template';
import * as orderCancelledEmail from './email/order-cancelled.template';
import * as orderConfirmedSms from './sms/order-confirmed.template';
import * as paymentFailedSms from './sms/payment-failed.template';

export interface RenderedTemplate {
  templateKey: string;
  subject: string;
  body: string;
}

export type TemplateData =
  | orderConfirmedEmail.OrderConfirmedEmailData
  | orderCancelledEmail.OrderCancelledEmailData
  | orderConfirmedSms.OrderConfirmedSmsData
  | paymentFailedSms.PaymentFailedSmsData;

@Injectable()
export class TemplatesService {
  render(
    type: NotificationType,
    channel: NotificationChannel,
    data: TemplateData,
  ): RenderedTemplate {
    switch (type) {
      case NotificationType.ORDER_CONFIRMED:
        return this.orderConfirmed(channel, data);
      case NotificationType.ORDER_CANCELLED:
        return this.orderCancelled(channel, data);
      case NotificationType.PAYMENT_FAILED:
        return this.paymentFailed(channel, data);
    }
  }

  private orderConfirmed(channel: NotificationChannel, data: TemplateData): RenderedTemplate {
    if (channel === NotificationChannel.SMS) {
      const rendered = orderConfirmedSms.render(data as orderConfirmedSms.OrderConfirmedSmsData);
      return { templateKey: orderConfirmedSms.TEMPLATE_KEY, ...rendered };
    }
    const rendered = orderConfirmedEmail.render(data as orderConfirmedEmail.OrderConfirmedEmailData);
    return { templateKey: orderConfirmedEmail.TEMPLATE_KEY, ...rendered };
  }

  private orderCancelled(channel: NotificationChannel, data: TemplateData): RenderedTemplate {
    // SMS template not yet defined — fall back to email content with SMS-safe body
    if (channel === NotificationChannel.SMS) {
      const d = data as orderCancelledEmail.OrderCancelledEmailData;
      return {
        templateKey: 'sms:order-cancelled:v1',
        subject: `Order ${d.orderId} cancelled`,
        body: `Your order ${d.orderId} has been cancelled. Contact support if you have questions.`,
      };
    }
    const rendered = orderCancelledEmail.render(data as orderCancelledEmail.OrderCancelledEmailData);
    return { templateKey: orderCancelledEmail.TEMPLATE_KEY, ...rendered };
  }

  private paymentFailed(channel: NotificationChannel, data: TemplateData): RenderedTemplate {
    if (channel === NotificationChannel.SMS) {
      const rendered = paymentFailedSms.render(data as paymentFailedSms.PaymentFailedSmsData);
      return { templateKey: paymentFailedSms.TEMPLATE_KEY, ...rendered };
    }
    // Email template for payment failed — inline since it mirrors SMS content
    const d = data as paymentFailedSms.PaymentFailedSmsData;
    const amount = this.formatAmount(d.amount, d.currency);
    return {
      templateKey: 'email:payment-failed:v1',
      subject: `Payment failed for order ${d.orderId}`,
      body: [
        `We were unable to process your payment.`,
        ``,
        `Order ID: ${d.orderId}`,
        `Amount: ${amount}`,
        ``,
        `Please update your payment method and try again, or contact our support team.`,
      ].join('\n'),
    };
  }

  private formatAmount(amount: string, currency: string): string {
    const numeric = parseFloat(amount);
    return isNaN(numeric) ? `${amount} ${currency}` : `${numeric.toFixed(2)} ${currency.toUpperCase()}`;
  }
}
