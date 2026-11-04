import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'inventory_reservation_items' })
@Index(
  'uq_inventory_reservation_items_reservation_product',
  ['reservationId', 'productId'],
  { unique: true },
)
export class InventoryReservationItemEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'reservation_id', type: 'char', length: 36 })
  reservationId!: string;

  @Column({ name: 'product_id', type: 'varchar', length: 120 })
  productId!: string;

  @Column({ type: 'int', unsigned: true })
  quantity!: number;
}
