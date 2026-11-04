import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  RelationId,
} from 'typeorm';
import type { Relation } from 'typeorm';

import { OrderEntity } from './order.entity';

/**
 * Stores a snapshot of an item included in an order.
 *
 * Product details and prices are captured at order creation so later catalog
 * changes do not rewrite the historical contents of an existing order.
 */
@Entity()
@Index('idx_order_items_product_id', ['productId'])
export class OrderItemEntity {
  /**
   * Application-generated UUID identifying this order line.
   */
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  /**
   * Product identifier from the trusted catalog or product service.
   */
  @Column({ name: 'product_id', type: 'varchar', length: 64 })
  productId!: string;

  /**
   * Product name captured when the order is created.
   */
  @Column({ name: 'product_name', type: 'varchar', length: 255 })
  productName!: string;

  /**
   * Number of units requested for this product.
   * The service must validate that this value is greater than zero.
   */
  @Column({ type: 'int', unsigned: true })
  quantity!: number;

  /**
   * Trusted unit price at the time the order was created.
   */
  @Column({
    name: 'unit_price',
    type: 'decimal',
    precision: 19,
    scale: 4,
  })
  unitPrice!: string;

  /**
   * Quantity multiplied by unit price, calculated by server-side logic.
   */
  @Column({
    name: 'line_total',
    type: 'decimal',
    precision: 19,
    scale: 4,
  })
  lineTotal!: string;

  /**
   * Owning order. Deleting an order with existing items is restricted
   * to protect the historical record.
   */
  @ManyToOne(() => OrderEntity, (order) => order.items, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'order_id', referencedColumnName: 'id' })
  order!: Relation<OrderEntity>;

  @RelationId((item: OrderItemEntity) => item.order)
  orderId!: string;
}
