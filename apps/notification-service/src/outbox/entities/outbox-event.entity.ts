import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

export enum NotificationOutboxStatus {
  PENDING = 'PENDING',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
}

@Entity({ name: 'notification_outbox_events' })
@Index('uq_notification_outbox_event_id', ['eventId'], { unique: true })
@Index('idx_notification_outbox_pending', ['status', 'nextRetryAt', 'createdAt'])
export class OutboxEventEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'event_id', type: 'char', length: 36 })
  eventId!: string;

  @Column({ name: 'aggregate_type', type: 'varchar', length: 80 })
  aggregateType!: string;

  @Column({ name: 'aggregate_id', type: 'char', length: 36 })
  aggregateId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 120 })
  eventType!: string;

  @Column({ type: 'json' })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 20, default: NotificationOutboxStatus.PENDING })
  status!: NotificationOutboxStatus;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @Column({ name: 'published_at', type: 'datetime', precision: 6, nullable: true })
  publishedAt!: Date | null;

  @Column({ name: 'failed_at', type: 'datetime', precision: 6, nullable: true })
  failedAt!: Date | null;

  @Column({ name: 'retry_count', type: 'int', unsigned: true, default: 0 })
  retryCount!: number;

  @Column({
    name: 'next_retry_at',
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  nextRetryAt!: Date;

  @Column({ name: 'last_error', type: 'varchar', length: 1000, nullable: true })
  lastError!: string | null;

  @Column({ name: 'locked_until', type: 'datetime', precision: 6, nullable: true })
  lockedUntil!: Date | null;

  @Column({ name: 'claim_token', type: 'char', length: 36, nullable: true })
  claimToken!: string | null;
}
