import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InboxModule } from '../inbox/inbox.module';
import { OperationsModule } from '../operations/operations.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentProviderModule } from '../providers/payment-provider.module';
import { PaymentCommandConsumer } from './consumers/payment-command-consumer';
import { PaymentAuthorizeConsumer } from './consumers/payment-authorize.consumer';
import { PaymentCaptureConsumer } from './consumers/payment-capture.consumer';
import { PaymentRefundConsumer } from './consumers/payment-refund.consumer';
import { PaymentVoidConsumer } from './consumers/payment-void.consumer';
import { RabbitMqConsumer } from './rabbitmq/rabbitmq-consumer';
import { RabbitMqModule } from './rabbitmq/rabbitmq.module';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    OperationsModule,
    OutboxModule,
    PaymentProviderModule,
    RabbitMqModule,
  ],
  providers: [
    PaymentCommandConsumer,
    PaymentAuthorizeConsumer,
    PaymentCaptureConsumer,
    PaymentVoidConsumer,
    PaymentRefundConsumer,
    RabbitMqConsumer,
  ],
})
export class MessagingModule {}
