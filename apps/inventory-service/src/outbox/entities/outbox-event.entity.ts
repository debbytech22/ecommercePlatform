import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity({ name: 'outbox_events' })
@Index('idx_inventory_outbox_pending', [
  'publishedAt',
  'failedAt',
  'nextAttemptAt',
  'lockedUntil',
  'createdAt',
])
export class OutboxEventEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'aggregate_type', type: 'varchar', length: 80 })
  aggregateType!: string;

  @Column({ name: 'aggregate_id', type: 'char', length: 36 })
  aggregateId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 120 })
  eventType!: string;

  @Column({ type: 'json' })
  payload!: Record<string, unknown>;

  @CreateDateColumn({
    name: 'created_at',
    type: 'datetime',
    precision: 6,
  })
  createdAt!: Date;

  @Column({
    name: 'published_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  publishedAt!: Date | null;

  @Column({
    name: 'failed_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  failedAt!: Date | null;

  @Column({ type: 'int', unsigned: true, default: 0 })
  attempts!: number;

  @Column({
    name: 'next_attempt_at',
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  nextAttemptAt!: Date;

  @Column({
    name: 'last_error',
    type: 'varchar',
    length: 1000,
    nullable: true,
  })
  lastError!: string | null;

  @Column({ name: 'locked_by', type: 'char', length: 36, nullable: true })
  lockedBy!: string | null;

  @Column({
    name: 'locked_until',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  lockedUntil!: Date | null;
}
