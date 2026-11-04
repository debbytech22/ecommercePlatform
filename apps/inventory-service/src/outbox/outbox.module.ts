import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OutboxEventEntity } from './entities/outbox-event.entity';
import { InventoryEventPublisher } from '../messaging/publishers/inventory-event.publisher';
import { RabbitMqModule } from '../messaging/rabbitmq/rabbitmq.module';
import { OutboxPublisherService } from './outbox-publisher.service';
import { OutboxRepository } from './outbox.repository';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEventEntity]), RabbitMqModule],
  providers: [
    InventoryEventPublisher,
    OutboxRepository,
    OutboxPublisherService,
  ],
  exports: [OutboxPublisherService],
})
export class OutboxModule {}
