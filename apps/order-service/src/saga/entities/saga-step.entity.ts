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
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'saga_id', type: 'char', length: 36 })
  sagaId!: string;

  @ManyToOne(() => OrderSagaEntity, (saga) => saga.steps, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'saga_id', referencedColumnName: 'id' })
  saga!: Relation<OrderSagaEntity>;

  @Column({ name: 'step_type', type: 'varchar', length: 40 })
  stepType!: SagaStepType;

  @Column({ type: 'varchar', length: 40 })
  status!: SagaStepStatus;

  @Column({ name: 'command_id', type: 'char', length: 36, nullable: true })
  commandId!: string | null;

  @Column({ name: 'operation_id', type: 'char', length: 36, nullable: true })
  operationId!: string | null;

  @Column({ name: 'attempts', type: 'int', unsigned: true, default: 0 })
  attemptCount!: number;

  @Column({ name: 'last_error', type: 'varchar', length: 1000, nullable: true })
  lastError!: string | null;

  @Column({ name: 'last_error_code', type: 'varchar', length: 100, nullable: true })
  lastErrorCode!: string | null;

  @Column({
    name: 'started_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  startedAt!: Date | null;

  @Column({
    name: 'deadline_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  deadlineAt!: Date | null;

  @Column({
    name: 'next_retry_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  nextRetryAt!: Date | null;

  @Column({
    name: 'completed_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  completedAt!: Date | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'datetime',
    precision: 6,
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 6,
  })
  updatedAt!: Date;
}
