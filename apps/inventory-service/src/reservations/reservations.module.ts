import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { InventoryReservationItemEntity } from './entities/inventory-reservation-item.entity';
import { InventoryReservationEntity } from './entities/inventory-reservation.entity';
import { ReservationsRepository } from './reservations.repository';
import { ReservationsService } from './reservations.service';
import { ReservationReleaseService } from './compensation/reservation-release.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InventoryReservationEntity,
      InventoryReservationItemEntity,
    ]),
  ],
  providers: [
    ReservationsRepository,
    ReservationsService,
    ReservationReleaseService,
  ],
  exports: [
    ReservationsRepository,
    ReservationsService,
    ReservationReleaseService,
  ],
})
export class ReservationsModule {}
