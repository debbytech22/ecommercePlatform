import { Module } from '@nestjs/common';

import { InboxModule } from '../inbox/inbox.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { RabbitMqModule } from './rabbitmq/rabbitmq.module';

@Module({
  imports: [InboxModule, OutboxModule, RabbitMqModule, ReservationsModule],
})
export class MessagingModule {}
