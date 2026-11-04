import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

export enum ReconciliationOutcome {
  RESOLVED = 'RESOLVED',
  STILL_PROCESSING = 'STILL_PROCESSING',
  NOT_FOUND = 'NOT_FOUND',
  INCONCLUSIVE = 'INCONCLUSIVE',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  ESCALATED = 'ESCALATED',
}

@Entity({ name: 'payment_reconciliation_history' })
@Index('idx_recon_history_operation_id', ['operationId', 'attemptedAt'])
export class ReconciliationHistoryEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'operation_id', type: 'char', length: 36 })
  operationId!: string;

  @Column({ name: 'attempt_number', type: 'int', unsigned: true })
  attemptNumber!: number;

  @Column({ type: 'varchar', length: 30 })
  outcome!: ReconciliationOutcome;

  @Column({ name: 'provider_status', type: 'varchar', length: 30, nullable: true })
  providerStatus!: string | null;

  @Column({ name: 'provider_reference', type: 'varchar', length: 255, nullable: true })
  providerReference!: string | null;

  @Column({ name: 'failure_code', type: 'varchar', length: 100, nullable: true })
  failureCode!: string | null;

  @Column({ name: 'error_message', type: 'varchar', length: 1000, nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'attempted_at', type: 'datetime', precision: 6 })
  attemptedAt!: Date;
}
