import {
  Column,
  Check,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PaymentStatus {
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  PARTIALLY_CAPTURED = 'PARTIALLY_CAPTURED',
  CAPTURED = 'CAPTURED',
  VOIDED = 'VOIDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  REFUNDED = 'REFUNDED',
  FAILED = 'FAILED',
  REQUIRES_RECONCILIATION = 'REQUIRES_RECONCILIATION',
}

@Entity({ name: 'payments' })
@Check(
  'chk_payments_amounts',
  '`amount` > 0 AND `authorized_amount` <= `amount` AND `captured_amount` <= `authorized_amount` AND `refunded_amount` <= `captured_amount`',
)
@Index('uq_payments_order_id', ['orderId'], { unique: true })
@Index('idx_payments_status_updated_at', ['status', 'updatedAt'])
export class PaymentEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'order_id', type: 'char', length: 36 })
  orderId!: string;

  @Column({ name: 'customer_id', type: 'varchar', length: 64 })
  customerId!: string;

  @Column({ type: 'varchar', length: 40 })
  status!: PaymentStatus;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'decimal', precision: 19, scale: 4, unsigned: true })
  amount!: string;

  @Column({
    name: 'authorized_amount',
    type: 'decimal',
    precision: 19,
    scale: 4,
    unsigned: true,
    default: 0,
  })
  authorizedAmount!: string;

  @Column({
    name: 'captured_amount',
    type: 'decimal',
    precision: 19,
    scale: 4,
    unsigned: true,
    default: 0,
  })
  capturedAmount!: string;

  @Column({
    name: 'refunded_amount',
    type: 'decimal',
    precision: 19,
    scale: 4,
    unsigned: true,
    default: 0,
  })
  refundedAmount!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;
}
