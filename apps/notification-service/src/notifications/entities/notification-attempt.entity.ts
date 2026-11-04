import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { DeliveryAttemptStatus, NotificationChannel } from '../notification-status.enum';

@Entity({ name: 'notification_attempts' })
@Index('idx_notification_attempt_notification_id', ['notificationId', 'attemptedAt'])
export class NotificationAttemptEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'notification_id', type: 'char', length: 36 })
  notificationId!: string;

  @Column({ name: 'attempt_number', type: 'int', unsigned: true })
  attemptNumber!: number;

  @Column({ type: 'varchar', length: 20 })
  channel!: NotificationChannel;

  @Column({ type: 'varchar', length: 60, nullable: true })
  provider!: string | null;

  @Column({ type: 'varchar', length: 20 })
  status!: DeliveryAttemptStatus;

  @Column({ name: 'provider_message_id', type: 'varchar', length: 255, nullable: true })
  providerMessageId!: string | null;

  @Column({ name: 'error_code', type: 'varchar', length: 100, nullable: true })
  errorCode!: string | null;

  @Column({ name: 'error_message', type: 'varchar', length: 1000, nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'attempted_at', type: 'datetime', precision: 6 })
  attemptedAt!: Date;

  @Column({ name: 'completed_at', type: 'datetime', precision: 6, nullable: true })
  completedAt!: Date | null;
}
