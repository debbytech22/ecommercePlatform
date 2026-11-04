import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { PaymentEventPublisher } from '../messaging/publishers/payment-event.publisher';
import { RabbitMqModule } from '../messaging/rabbitmq/rabbitmq.module';
import { OutboxEventEntity } from './entities/outbox-event.entity';
import { OutboxRepository } from './outbox.repository';
import { OutboxPublisherService } from './outbox-publisher.service';

@Module({
  imports: [
    ConfigModule,
    RabbitMqModule,
    TypeOrmModule.forFeature([OutboxEventEntity]),
  ],
  providers: [OutboxRepository, OutboxPublisherService, PaymentEventPublisher],
  exports: [OutboxPublisherService, PaymentEventPublisher],
})
export class OutboxModule {}
