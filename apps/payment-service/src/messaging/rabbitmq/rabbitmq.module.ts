import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RabbitMqPublisherChannel } from './rabbitmq-publisher-channel';

@Module({
  imports: [ConfigModule],
  providers: [RabbitMqPublisherChannel],
  exports: [RabbitMqPublisherChannel],
})
export class RabbitMqModule {}
