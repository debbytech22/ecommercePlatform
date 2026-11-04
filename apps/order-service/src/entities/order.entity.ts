import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

import { OrderItemEntity } from './order-item.entity';

/**
 * Represents the lifecycle of an order in the order-processing Saga.
 *
 * These states describe persisted business progress, not merely HTTP results.
 */
export enum OrderStatus {
  PENDING = 'PENDING',
  RESERVING_INVENTORY = 'RESERVING_INVENTORY',
  PROCESSING_PAYMENT = 'PROCESSING_PAYMENT',
  CONFIRMED = 'CONFIRMED',
  CANCELLATION_PENDING = 'CANCELLATION_PENDING',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
  REQUIRES_RECONCILIATION = 'REQUIRES_RECONCILIATION',
}

/**
 * Stores the authoritative order record owned by the Order Service.
 *
 * The application generates UUIDs before persistence. Prices and totals
 * must be calculated from trusted server-side pricing data, never accepted
 * as authoritative values from the client.
 */
@Entity({ name: 'orders' })
@Index('uq_orders_customer_idempotency', ['customerId', 'idempotencyKey'], {
  unique: true,
})
@Index('idx_orders_customer_created_at', ['customerId', 'createdAt'])
@Index('idx_orders_status_created_at', ['status', 'createdAt'])
export class OrderEntity {
  /**
   * Application-generated UUID identifying the order.
   */
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  /**
   * Identifier of the customer who owns this order.
   * The service must derive or validate this identity through trusted auth.
   */
  @Column({ name: 'customer_id', type: 'varchar', length: 64 })
  customerId!: string;

  /**
   * Client-provided idempotency key, scoped to a customer by a unique index.
   * Repeated requests with the same key must be handled by application logic.
   */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey!: string;

  /**
   * Persisted workflow state used by the order Saga and recovery process.
   */
  @Column({
    type: 'varchar',
    length: 40,
    default: OrderStatus.PENDING,
  })
  status!: OrderStatus;

  /**
   * ISO 4217 currency code, such as NGN or USD.
   * The service must validate supported currencies before creating orders.
   */
  @Column({ type: 'char', length: 3 })
  currency!: string;

  /**
   * Sum of the order's item prices before additional charges or discounts.
   * DECIMAL values are represented as strings to avoid floating-point errors.
   */
  @Column({
    name: 'subtotal_amount',
    type: 'decimal',
    precision: 19,
    scale: 4,
  })
  subtotalAmount!: string;

  /**
   * Final amount due, calculated by trusted server-side pricing logic.
   */
  @Column({
    name: 'total_amount',
    type: 'decimal',
    precision: 19,
    scale: 4,
  })
  totalAmount!: string;

  /**
   * Creation time assigned by the database.
   */
  @CreateDateColumn({
    name: 'created_at',
    type: 'datetime',
    precision: 6,
  })
  createdAt!: Date;

  /**
   * Last-update time maintained by TypeORM when the record is saved.
   */
  @UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 6,
  })
  updatedAt!: Date;

  /**
   * Optimistic concurrency version maintained by TypeORM.
   * Critical state transitions still require explicit concurrency safeguards.
   */
  @VersionColumn({ type: 'int', unsigned: true })
  version!: number;

  @Column({
    name: 'request_hash',
    type: 'char',
    length: 64,
    nullable: true,
  })
  requestHash!: string | null;

  /**
   * Order items are persisted explicitly in transactions; cascading writes
   * are intentionally not enabled.
   */
  @OneToMany(() => OrderItemEntity, (item) => item.order)
  items!: OrderItemEntity[];

  itemCount?: number;
}
