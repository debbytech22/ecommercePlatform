import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { SagaStepStatus } from '../enums/saga-step-status.enum';
import { OrderSagaEntity } from './order-saga.entity';

export enum SagaStepType {
  INVENTORY_RESERVATION = 'INVENTORY_RESERVATION',
  PAYMENT_AUTHORIZATION = 'PAYMENT_AUTHORIZATION',
  PAYMENT_RECONCILIATION = 'PAYMENT_RECONCILIATION',
  PAYMENT_VOID = 'PAYMENT_VOID',
  PAYMENT_REFUND = 'PAYMENT_REFUND',
  INVENTORY_RELEASE = 'INVENTORY_RELEASE',
}

@Entity({ name: 'saga_steps' })
@Index('uq_saga_steps_saga_type', ['sagaId', 'stepType'], { unique: true })
@Index('idx_saga_steps_status_updated_at', ['status', 'updatedAt'])
@Index('uq_saga_steps_command_id', ['commandId'], { unique: true })
@Index('uq_saga_steps_operation_id', ['operationId'], { unique: true })
@Index('idx_saga_steps_recovery_deadline', ['status', 'deadlineAt'])
export class SagaStepEntity {
  @PrimaryColumn()
  id!: string;

  @Column()
  sagaId!: string;

  @ManyToOne(() => OrderSagaEntity, (saga) => saga.steps, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn()
  saga!: Relation<OrderSagaEntity>;

  @Column()
  stepType!: SagaStepType;

  @Column()
  status!: SagaStepStatus;

  @Column({nullable: true })
  commandId!: string | null;

  @Column({ nullable: true })
  operationId!: string | null;

  @Column({default: 0 })
  attemptCount!: number;

  @Column({nullable: true })
  lastError!: string | null;

  @Column({nullable: true })
  lastErrorCode!: string | null;

  @Column({
    nullable: true,
  })
  startedAt!: Date | null;

  @Column({
    nullable: true,
  })
  deadlineAt!: Date | null;

  @Column({
    nullable: true,
  })
  nextRetryAt!: Date | null;

  @Column({
    nullable: true,
  })
  completedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
