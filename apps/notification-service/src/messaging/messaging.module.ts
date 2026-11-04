import { Module } from '@nestjs/common';
import { OrderCancelledConsumer } from './consumers/order-cancelled.consumer';
import { OrderConfirmedConsumer } from './consumers/order-confirmed.consumer';
import { PaymentFailedConsumer } from './consumers/payment-failed.consumer';
import { NotificationEventPublisher } from './publishers/notification-event.publisher';
import { RabbitMqConsumer } from './rabbitmq/rabbitmq-consumer';
import { RabbitMqModule } from './rabbitmq/rabbitmq.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TemplatesModule } from '../templates/templates.module';

@Module({
  imports: [RabbitMqModule, NotificationsModule, TemplatesModule],
  providers: [
    OrderConfirmedConsumer,
    OrderCancelledConsumer,
    PaymentFailedConsumer,
    NotificationEventPublisher,
    RabbitMqConsumer,
  ],
  exports: [NotificationEventPublisher],
})
export class MessagingModule {}
