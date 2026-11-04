import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryServiceController } from './inventory-service.controller';
import { InventoryServiceService } from './inventory-service.service';
import { getInventoryDatabaseOptions } from './config/database-options';
import { ProductInventoryEntity } from './inventory/entities/product-inventory.entity';
import { InboxEventEntity } from './inbox/entities/inbox-event.entity';
import { InventoryReservationItemEntity } from './reservations/entities/inventory-reservation-item.entity';
import { InventoryReservationEntity } from './reservations/entities/inventory-reservation.entity';
import { OutboxEventEntity } from './outbox/entities/outbox-event.entity';
import { InventoryModule } from './inventory/inventory.module';
import { MessagingModule } from './messaging/messaging.module';
import { ReservationsModule } from './reservations/reservations.module';
import { ObservabilityModule } from './observability/observability.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        ...getInventoryDatabaseOptions(process.env),
        entities: [
          ProductInventoryEntity,
          InventoryReservationEntity,
          InventoryReservationItemEntity,
          InboxEventEntity,
          OutboxEventEntity,
        ],
        synchronize: false,
        migrationsRun: false,
      }),
    }),
    TypeOrmModule.forFeature([ProductInventoryEntity]),
    InventoryModule,
    ObservabilityModule,
    ReservationsModule,
    MessagingModule,
  ],
  controllers: [InventoryServiceController],
  providers: [InventoryServiceService],
})
export class InventoryServiceModule {}
