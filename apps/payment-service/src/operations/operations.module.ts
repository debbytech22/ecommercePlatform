import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentProviderModule } from '../providers/payment-provider.module';
import { ReconciliationHistoryEntity } from '../reconciliation/entities/reconciliation-history.entity';
import { ProviderStatusService } from '../reconciliation/provider-status.service';
import { OperationsService } from './operations.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ReconciliationHistoryEntity]),
    PaymentsModule,
    PaymentProviderModule,
  ],
  providers: [ProviderStatusService, OperationsService],
  exports: [OperationsService],
})
export class OperationsModule {}
