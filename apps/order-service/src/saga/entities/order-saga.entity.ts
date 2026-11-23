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

@Entity()
@Index('uq_order_sagas_order_id', ['orderId'], { unique: true })
@Index('idx_order_sagas_recovery', ['currentState', 'updatedAt'])
export class OrderSagaEntity {
  @PrimaryColumn()
  id!: string;

  @Column()
  orderId!: string;

  @OneToOne(() => OrderEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id', referencedColumnName: 'id' })
  order!: Relation<OrderEntity>;

  @Column()
  currentState!: SagaState;

  @Column()
  correlationId!: string;

  @Column({
    nullable: true,
  })
  inventoryReservationId!: string | null;

  @Column({
    nullable: true,
  })
  inventoryReservationStatus!: 'RESERVED' | 'RELEASED' | null;

  @Column({ type: 'json', nullable: true })
  inventoryReservationItems!: PersistedReservationItem[] | null;

  @Column({
    nullable: true,
  })
  paymentOperationId!: string | null;

  @Column({
    nullable: true,
  })
  paymentAuthorizationId!: string | null;

  @Column({
    nullable: true,
  })
  paymentId!: string | null;

  @Column({
    type: 'decimal',
    precision: 19,
    scale: 4,
    nullable: true,
  })
  paymentAmount!: string | null;

  @Column({
    nullable: true,
  })
  paymentCurrency!: string | null;

  @Column({
    nullable: true,
  })
  paymentStatus!: 'AUTHORIZED' | 'CAPTURED' | null;

  @Column({
    nullable: true,
  })
  failureCode!: string | null;

  @Column({
    nullable: true,
  })
  failureReason!: string | null;

  @Column({
    nullable: true,
  })
  compensationCausationId!: string | null;

  @Column({
    nullable: true,
  })
  compensationReason!: CompensationReason | null;

  @Column({
    nullable: true,
  })
  compensationStatus!: CompensationStatus | null;

  @Column({
    nullable: true,
  })
  compensationStartedAt!: Date | null;

  @Column({
    nullable: true,
  })
  compensationCompletedAt!: Date | null;

  @Column({
    nullable: true,
  })
  compensationFailureReason!: string | null;

  @Column()
  startedAt!: Date;

  @Column({
    nullable: true,
  })
  completedAt!: Date | null;

  @VersionColumn({ type: 'int', unsigned: true })
  version!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => SagaStepEntity, (step) => step.saga)
  steps!: Relation<SagaStepEntity[]>;
}
