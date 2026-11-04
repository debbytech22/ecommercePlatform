import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OutboxEventEntity } from '../entities/outbox-event.entity';
import { OutboxRepository } from './outbox.repository';
import { OutboxPublisherService } from './outbox-publisher.service';
import { RabbitMqModule } from './rabbitmq/rabbitmq.module';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEventEntity]), RabbitMqModule],
  providers: [OutboxRepository, OutboxPublisherService],
  exports: [OutboxPublisherService],
})
export class OutboxModule {}
