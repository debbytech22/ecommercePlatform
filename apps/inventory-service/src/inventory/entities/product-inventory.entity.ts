import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'product_inventory' })
export class ProductInventoryEntity {
  @PrimaryColumn({ name: 'product_id', type: 'varchar', length: 120 })
  productId!: string;

  @Column({ name: 'on_hand', type: 'int', unsigned: true, default: 0 })
  onHand!: number;

  @Column({ name: 'reserved', type: 'int', unsigned: true, default: 0 })
  reserved!: number;

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
