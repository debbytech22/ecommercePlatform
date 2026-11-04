import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { InboxModule } from '../../inbox/inbox.module';
import { ReservationsModule } from '../../reservations/reservations.module';
import { OrderCreatedConsumer } from '../consumers/order-created.consumer';
import { InventoryReleaseConsumer } from '../consumers/inventory-release.consumer';
import { RabbitMqConsumer } from './rabbitmq.consumer';
import { RabbitMqPublisherChannel } from './rabbitmq.publisher-channel';

@Module({
  imports: [ConfigModule, InboxModule, ReservationsModule],
  providers: [
    OrderCreatedConsumer,
    InventoryReleaseConsumer,
    RabbitMqConsumer,
    RabbitMqPublisherChannel,
  ],
  exports: [RabbitMqConsumer, RabbitMqPublisherChannel],
})
export class RabbitMqModule {}
