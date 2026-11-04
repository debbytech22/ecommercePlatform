import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SagaRecoveryService } from '../services/saga-recovery.service';
import { SagaTimeoutService } from './saga-timeout.service';
import { CrossServiceReconciliationService } from './saga-reconciliation.service';
import { RecoveryPolicyService } from './recovery-policy.service';
import { StaleWorkflowDetector } from './stale-workflow.detector';
import { SagaRecoveryAttemptEntity } from '../entities/saga-recovery-attempt.entity';
import { OrderSagaEntity } from '../entities/order-saga.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SagaRecoveryAttemptEntity, OrderSagaEntity]),
  ],
  providers: [
    RecoveryPolicyService,
    SagaTimeoutService,
    CrossServiceReconciliationService,
    StaleWorkflowDetector,
    SagaRecoveryService,
  ],
  exports: [
    SagaRecoveryService,
    SagaTimeoutService,
    RecoveryPolicyService,
    CrossServiceReconciliationService,
    StaleWorkflowDetector,
  ],
})
export class SagaRecoveryModule {}
