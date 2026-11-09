import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity({ name: 'outbox_events' })
@Index('idx_outbox_pending', [
  'publishedAt',
  'failedAt',
  'nextAttemptAt',
  'lockedUntil',
  'createdAt',
])
@Index('uq_outbox_command_id', ['commandId'], { unique: true })
export class OutboxEventEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({  length: 80 })
  aggregateType!: string;

  @Column({   length: 36 })
  aggregateId!: string;

  @Column({  length: 120 })
  eventType!: string;

  @Column({ length: 36, nullable: true })
  commandId!: string | null;

  @Column({ type: 'json' })
  payload!: Record<string, unknown>;

  @CreateDateColumn({
    type: 'datetime',
    precision: 6,
  })
  createdAt!: Date;

  @Column({
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  publishedAt!: Date | null;

  @Column({
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  failedAt!: Date | null;

  @Column({ type: 'int', unsigned: true, default: 0 })
  attempts!: number;

  @Column({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  nextAttemptAt!: Date;

  @Column({
    type: 'varchar',
    length: 1000,
    nullable: true,
  })
  lastError!: string | null;

  @Column({
    type: 'char',
    length: 36,
    nullable: true,
  })
  lockedBy!: string | null;

  @Column({
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  lockedUntil!: Date | null;
}
