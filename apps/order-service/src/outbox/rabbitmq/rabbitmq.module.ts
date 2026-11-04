import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { RABBITMQ_CONNECTION, RabbitMqConnection } from './rabbitmq.connection';
import { RabbitMqPublisher } from './rabbitmq.publisher';

@Module({
  imports: [ConfigModule],
  providers: [
    RabbitMqConnection,
    {
      provide: RABBITMQ_CONNECTION,
      useExisting: RabbitMqConnection,
    },
    RabbitMqPublisher,
  ],
  exports: [RabbitMqPublisher],
})
export class RabbitMqModule {}
