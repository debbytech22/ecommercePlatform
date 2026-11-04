
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { NotificationCategory, NotificationChannel, NotificationType } from '../notification-status.enum';

@Entity({ name: 'notification_preferences' })
@Index('uq_notification_preference', ['recipientId', 'type', 'channel'], { unique: true })
export class NotificationPreferenceEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'recipient_id', type: 'char', length: 36 })
  recipientId!: string;

  @Column({ name: 'notification_type', type: 'varchar', length: 60 })
  type!: NotificationType;

  @Column({ type: 'varchar', length: 20 })
  channel!: NotificationChannel;

  @Column({ type: 'varchar', length: 20, default: NotificationCategory.TRANSACTIONAL })
  category!: NotificationCategory;

  @Column({ name: 'is_enabled', type: 'tinyint', unsigned: true, default: 1 })
  isEnabled!: boolean;

  @Column({ name: 'suppressed_at', type: 'datetime', precision: 6, nullable: true })
  suppressedAt!: Date | null;

  @Column({ name: 'suppression_reason', type: 'varchar', length: 255, nullable: true })
  suppressionReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;
}
