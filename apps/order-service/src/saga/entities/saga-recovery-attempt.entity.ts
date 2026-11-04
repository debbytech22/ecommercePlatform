import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

export enum RecoveryAttemptStatus {
  ATTEMPTED = 'ATTEMPTED',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

@Entity({ name: 'saga_recovery_attempts' })
@Index('idx_saga_recovery_saga_id', ['sagaId', 'createdAt'])
export class SagaRecoveryAttemptEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'saga_id', type: 'char', length: 36 })
  sagaId!: string;

  @Column({ name: 'attempt_number', type: 'int', unsigned: true })
  attemptNumber!: number;

  @Column({ type: 'varchar', length: 20, default: RecoveryAttemptStatus.ATTEMPTED })
  status!: RecoveryAttemptStatus;

  @Column({ name: 'error_message', type: 'varchar', length: 1000, nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;
}
