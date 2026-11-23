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

  @Column()
  sagaId!: string;

  @Column()
  attemptNumber!: number;

  @Column({  default: RecoveryAttemptStatus.ATTEMPTED })
  status!: RecoveryAttemptStatus;

  @Column({  nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
