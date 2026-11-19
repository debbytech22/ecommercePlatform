import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class ProductInventoryEntity {
  @PrimaryColumn()
  productId!: string;

  @Column({ unsigned: true, default: 0 })
  onHand!: number;

  @Column({ unsigned: true, default: 0 })
  reserved!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
