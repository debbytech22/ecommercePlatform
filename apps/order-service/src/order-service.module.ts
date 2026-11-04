import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'node:path';

import { OrderGrpcController } from './order-service.controller';
import { OrderServiceService } from './order-service.service';
import { validateDatabaseEnv } from './config/database-env';
import { getDatabaseOptions } from './config/database-options';

import { OrderEntity } from './entities/order.entity';
import { OrderItemEntity } from './entities/order-item.entity';
import { OutboxEventEntity } from './entities/outbox-event.entity';

import { PRODUCT_PRICING_PORT } from './pricing/product-pricing.port';
import {
  CATALOG_GRPC_CLIENT,
  ProductPricingGrpcClient,
} from './pricing/product-pricing.grpc';
import { OutboxModule } from './outbox/outbox.module';
import { SagaModule } from './saga/saga.module';
import { InboxEventEntity } from './inbox/inbox-event.entity';
import { OrderSagaEntity } from './saga/entities/order-saga.entity';
import { SagaStepEntity } from './saga/entities/saga-step.entity';
import { OrderStatusHistoryEntity } from './entities/order-status-history.entity';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateDatabaseEnv,
    }),

    ClientsModule.registerAsync([
      {
        name: CATALOG_GRPC_CLIENT,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            package: 'ecommerce.catalog.v1',
            protoPath: join(__dirname, 'proto', 'catalog.proto'),
            url: config.get<string>('CATALOG_GRPC_URL', '127.0.0.1:50052'),
          },
        }),
      },
    ]),

    TypeOrmModule.forRoot({
      ...getDatabaseOptions(process.env),
      entities: [
        OrderEntity,
        OrderItemEntity,
        OrderStatusHistoryEntity,
        OutboxEventEntity,
        InboxEventEntity,
        OrderSagaEntity,
        SagaStepEntity,
      ],
      synchronize: false,
      migrationsRun: false,
    }),

    TypeOrmModule.forFeature([OrderEntity, OrderItemEntity, OutboxEventEntity]),
    OrdersModule,
    OutboxModule,
    SagaModule,
  ],
  controllers: [OrderGrpcController],
  providers: [
    OrderServiceService,
    ProductPricingGrpcClient,
    {
      provide: PRODUCT_PRICING_PORT,
      useExisting: ProductPricingGrpcClient,
    },
  ],
})
export class OrderServiceModule {}
