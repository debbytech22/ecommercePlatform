import { Module } from '@nestjs/common';
import { ReservationRecoveryService } from './reservation-recovery.service';
import { ReservationRecoveryWorker } from './reservation-recovery.worker';
import { InventoryReconciliationService } from './inventory-reconciliation.service';

@Module({
  providers: [
    ReservationRecoveryService,
    ReservationRecoveryWorker,
    InventoryReconciliationService,
  ],
  exports: [ReservationRecoveryService, InventoryReconciliationService],
})
export class InventoryRecoveryModule {}
