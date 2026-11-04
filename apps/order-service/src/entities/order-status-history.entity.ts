import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  JoinColumn,
  PrimaryColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { OrderEntity, OrderStatus } from './order.entity';

@Entity({ name: 'order_status_history' })
@Index('idx_order_status_history_order_id', ['orderId', 'occurredAt'])
@Index(
  'uq_order_status_history_order_sequence',
  ['orderId', 'sequenceNumber'],
  {
    unique: true,
  },
)
export class OrderStatusHistoryEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'order_id', type: 'char', length: 36 })
  orderId!: string;

  @Column({ name: 'sequence_number', type: 'int', unsigned: true })
  sequenceNumber!: number;

  @Column({ name: 'from_status', type: 'varchar', length: 40, nullable: true })
  fromStatus!: OrderStatus | null;

  @Column({ name: 'to_status', type: 'varchar', length: 40 })
  toStatus!: OrderStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  @Column({
    name: 'reason_code',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  reasonCode!: string | null;

  @Column({
    name: 'correlation_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  correlationId!: string | null;

  @Column({
    name: 'causation_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  causationId!: string | null;

  @CreateDateColumn({ name: 'occurred_at', type: 'datetime', precision: 6 })
  occurredAt!: Date;

  @ManyToOne(() => OrderEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id', referencedColumnName: 'id' })
  order!: Relation<OrderEntity>;
}
