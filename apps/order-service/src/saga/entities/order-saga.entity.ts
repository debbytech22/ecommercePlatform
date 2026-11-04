import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { OrderEntity } from '../../entities/order.entity';
import { SagaState } from '../enums/saga-state.enum';
import { SagaStepEntity } from './saga-step.entity';
import {
  CompensationReason,
  CompensationStatus,
} from '../compensation/compensation.types';

export interface PersistedReservationItem {
  productId: string;
  quantity: number;
}

@Entity({ name: 'order_sagas' })
@Index('uq_order_sagas_order_id', ['orderId'], { unique: true })
@Index('idx_order_sagas_recovery', ['currentState', 'updatedAt'])
export class OrderSagaEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'order_id', type: 'char', length: 36 })
  orderId!: string;

  @OneToOne(() => OrderEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id', referencedColumnName: 'id' })
  order!: Relation<OrderEntity>;

  @Column({ name: 'state', type: 'varchar', length: 40 })
  currentState!: SagaState;

  @Column({ name: 'correlation_id', type: 'char', length: 36 })
  correlationId!: string;

  @Column({
    name: 'reservation_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  inventoryReservationId!: string | null;

  @Column({
    name: 'inventory_reservation_status',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  inventoryReservationStatus!: 'RESERVED' | 'RELEASED' | null;

  @Column({ name: 'inventory_reservation_items', type: 'json', nullable: true })
  inventoryReservationItems!: PersistedReservationItem[] | null;

  @Column({
    name: 'payment_operation_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  paymentOperationId!: string | null;

  @Column({
    name: 'payment_authorization_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  paymentAuthorizationId!: string | null;

  @Column({
    name: 'payment_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  paymentId!: string | null;

  @Column({
    name: 'payment_amount',
    type: 'decimal',
    precision: 19,
    scale: 4,
    nullable: true,
  })
  paymentAmount!: string | null;

  @Column({
    name: 'payment_currency',
    type: 'char',
    length: 3,
    nullable: true,
  })
  paymentCurrency!: string | null;

  @Column({
    name: 'payment_status',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  paymentStatus!: 'AUTHORIZED' | 'CAPTURED' | null;

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
    name: 'compensation_causation_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  compensationCausationId!: string | null;

  @Column({
    name: 'compensation_reason',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  compensationReason!: CompensationReason | null;

  @Column({
    name: 'compensation_status',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  compensationStatus!: CompensationStatus | null;

  @Column({
    name: 'compensation_started_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  compensationStartedAt!: Date | null;

  @Column({
    name: 'compensation_completed_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  compensationCompletedAt!: Date | null;

  @Column({
    name: 'compensation_failure_reason',
    type: 'varchar',
    length: 1000,
    nullable: true,
  })
  compensationFailureReason!: string | null;

  @Column({
    name: 'started_at',
    type: 'datetime',
    precision: 6,
  })
  startedAt!: Date;

  @Column({
    name: 'completed_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  completedAt!: Date | null;

  @VersionColumn({ type: 'int', unsigned: true })
  version!: number;

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

  @OneToMany(() => SagaStepEntity, (step) => step.saga)
  steps!: Relation<SagaStepEntity[]>;
}
