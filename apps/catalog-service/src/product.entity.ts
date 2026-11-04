import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity({ name: 'catalog_products' })
@Index('uq_catalog_product_id', ['productId'], { unique: true })
@Index('idx_catalog_active', ['active'])
export class ProductEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    name: 'product_id',
    type: 'varchar',
    length: 64,
  })
  productId!: string;

  @Column({
    name: 'product_name',
    type: 'varchar',
    length: 255,
  })
  productName!: string;

  @Column({
    name: 'unit_price',
    type: 'decimal',
    precision: 19,
    scale: 4,
  })
  unitPrice!: string;

  @Column({
    type: 'char',
    length: 3,
  })
  currency!: string;

  @Column({
    type: 'boolean',
    default: true,
  })
  active!: boolean;

  @VersionColumn({ unsigned: true })
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
}