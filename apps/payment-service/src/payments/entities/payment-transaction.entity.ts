import {
  Column,
  Check,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { PaymentEntity } from './payment.entity';
import { PaymentOperationEntity } from './payment-operation.entity';

@Entity({ name: 'payment_transactions' })
@Check('chk_payment_transactions_amount', '`amount` > 0')
@Index('uq_payment_transactions_provider_reference', ['providerReference'], {
  unique: true,
})
@Index('idx_payment_transactions_payment_created_at', [
  'paymentId',
  'createdAt',
])
export class PaymentTransactionEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'payment_id', type: 'char', length: 36 })
  paymentId!: string;

  @ManyToOne(() => PaymentEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'payment_id', referencedColumnName: 'id' })
  payment!: Relation<PaymentEntity>;

  @Column({ name: 'operation_id', type: 'char', length: 36 })
  operationId!: string;

  @ManyToOne(() => PaymentOperationEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'operation_id', referencedColumnName: 'operationId' })
  operation!: Relation<PaymentOperationEntity>;

  @Column({
    name: 'provider_reference',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerReference!: string | null;

  @Column({ name: 'transaction_type', type: 'varchar', length: 32 })
  transactionType!: string;

  @Column({ type: 'varchar', length: 32 })
  status!: string;

  @Column({ type: 'decimal', precision: 19, scale: 4, unsigned: true })
  amount!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;
}
