import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OperationsModule } from '../operations/operations.module';
import { ReconciliationHistoryEntity } from './entities/reconciliation-history.entity';
import { ProviderStatusService } from './provider-status.service';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationWorker } from './reconciliation.worker';

@Module({
  imports: [
    TypeOrmModule.forFeature([ReconciliationHistoryEntity]),
    OperationsModule,
  ],
  providers: [
    ProviderStatusService,
    ReconciliationService,
    ReconciliationWorker,
  ],
  exports: [ReconciliationService, ProviderStatusService],
})
export class ReconciliationModule {}
