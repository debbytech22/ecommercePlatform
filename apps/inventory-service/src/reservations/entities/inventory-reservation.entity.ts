import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum InventoryReservationStatus {
  RESERVED = 'RESERVED',
  FAILED = 'FAILED',
  RELEASED = 'RELEASED',
}

@Entity({ name: 'inventory_reservations' })
@Index('uq_inventory_reservations_order_id', ['orderId'], { unique: true })
@Index(
  'uq_inventory_reservations_release_operation_id',
  ['releaseOperationId'],
  {
    unique: true,
  },
)
export class InventoryReservationEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'order_id', type: 'char', length: 36 })
  orderId!: string;

  @Column({
    type: 'varchar',
    length: 32,
  })
  status!: InventoryReservationStatus;

  @Column({
    name: 'release_operation_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  releaseOperationId!: string | null;

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
