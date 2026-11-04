import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
} from '../notification-status.enum';

@Entity({ name: 'notifications' })
@Index('idx_notification_recipient_status', ['recipientId', 'status'])
@Index('idx_notification_correlation', ['correlationId'])
@Index('idx_notification_pending', ['status', 'nextRetryAt'])
@Index('uq_notification_event_recipient_channel', ['eventId', 'recipientAddress', 'channel'], { unique: true })
export class NotificationEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'recipient_id', type: 'char', length: 36 })
  recipientId!: string;

  @Column({ name: 'order_id', type: 'char', length: 36, nullable: true })
  orderId!: string | null;

  @Column({ name: 'event_id', type: 'char', length: 36 })
  eventId!: string;

  @Column({ name: 'correlation_id', type: 'char', length: 36 })
  correlationId!: string;

  @Column({ name: 'causation_id', type: 'char', length: 36, nullable: true })
  causationId!: string | null;

  @Column({ name: 'notification_type', type: 'varchar', length: 60 })
  type!: NotificationType;

  @Column({ type: 'varchar', length: 20 })
  channel!: NotificationChannel;

  @Column({ type: 'varchar', length: 20 })
  status!: NotificationStatus;

  @Column({ name: 'recipient_address', type: 'varchar', length: 320 })
  recipientAddress!: string;

  @Column({ name: 'template_key', type: 'varchar', length: 120 })
  templateKey!: string;

  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ name: 'retry_count', type: 'int', unsigned: true, default: 0 })
  retryCount!: number;

  @Column({ name: 'next_retry_at', type: 'datetime', precision: 6, nullable: true })
  nextRetryAt!: Date | null;

  @Column({ name: 'sent_at', type: 'datetime', precision: 6, nullable: true })
  sentAt!: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 1000, nullable: true })
  lastError!: string | null;

  @Column({ name: 'provider_message_id', type: 'varchar', length: 255, nullable: true })
  providerMessageId!: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 120 })
  idempotencyKey!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;
}
