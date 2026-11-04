import {
  Column,
  Check,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { PaymentEntity } from './payment.entity';

export enum PaymentOperationType {
  AUTHORIZE = 'AUTHORIZE',
  CAPTURE = 'CAPTURE',
  VOID = 'VOID',
  REFUND = 'REFUND',
  RECONCILE = 'RECONCILE',
}

export enum PaymentOperationStatus {
  PENDING = 'PENDING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
  PROCESSING = 'PROCESSING',
  REQUIRES_RECONCILIATION = 'REQUIRES_RECONCILIATION',
  MANUAL_INTERVENTION_REQUIRED = 'MANUAL_INTERVENTION_REQUIRED',
}

@Entity({ name: 'payment_operations' })
@Check('chk_payment_operations_amount', '`amount` IS NULL OR `amount` > 0')
@Index('uq_payment_operations_operation_id', ['operationId'], { unique: true })
@Index('uq_payment_operations_command_id', ['commandId'], { unique: true })
@Index('uq_payment_operations_idempotency_key', ['idempotencyKey'], {
  unique: true,
})
@Index('uq_payment_operations_provider_reference', ['providerReference'], {
  unique: true,
})
@Index('idx_payment_operations_payment_type', ['paymentId', 'type'])
@Index('idx_payment_operations_reconciliation', [
  'status',
  'nextReconciliationAt',
  'processingLeaseUntil',
])
export class PaymentOperationEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'payment_id', type: 'char', length: 36 })
  paymentId!: string;

  @ManyToOne(() => PaymentEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'payment_id', referencedColumnName: 'id' })
  payment!: Relation<PaymentEntity>;

  @Column({ name: 'order_id', type: 'char', length: 36 })
  orderId!: string;

  @Column({ name: 'operation_id', type: 'char', length: 36 })
  operationId!: string;

  @Column({
    name: 'authorization_operation_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  authorizationOperationId!: string | null;

  @Column({ name: 'command_id', type: 'char', length: 36 })
  commandId!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey!: string;

  @Column({ name: 'operation_type', type: 'varchar', length: 32 })
  type!: PaymentOperationType;

  @Column({ name: 'operation_status', type: 'varchar', length: 32 })
  status!: PaymentOperationStatus;

  @Column({
    type: 'decimal',
    precision: 19,
    scale: 4,
    unsigned: true,
    nullable: true,
  })
  amount!: string | null;

  @Column({
    name: 'provider_reference',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerReference!: string | null;

  @Column({
    name: 'failure_code',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  failureCode!: string | null;

  @Column({
    name: 'failure_reason',
    type: 'varchar',
    length: 1000,
    nullable: true,
  })
  failureReason!: string | null;

  @Column({
    name: 'processing_lease_until',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  processingLeaseUntil!: Date | null;

  @Column({
    name: 'reconciliation_attempt_count',
    type: 'int',
    unsigned: true,
    default: 0,
  })
  reconciliationAttemptCount!: number;

  @Column({
    name: 'next_reconciliation_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  nextReconciliationAt!: Date | null;

  @Column({
    name: 'manual_intervention_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  manualInterventionAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;
}
