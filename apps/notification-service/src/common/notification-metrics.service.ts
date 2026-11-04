import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationEntity } from '../notifications/entities/notification.entity';
import { NotificationStatus } from '../notifications/notification-status.enum';

@Injectable()
export class NotificationMetricsService {
  private readonly logger = new Logger('NotificationMetrics');

  constructor(private readonly dataSource: DataSource) {}

  recordCreated(notificationId: string, channel: string, type: string, correlationId: string): void {
    this.logger.log(JSON.stringify({
      event: 'notification.metric',
      metric: 'notifications_created_total',
      value: 1,
      notificationId,
      channel,
      type,
      correlationId,
    }));
  }

  recordSent(notificationId: string, eventId: string, orderId: string | null, correlationId: string, provider: string, attemptNumber: number, latencyMs: number): void {
    this.logger.log(JSON.stringify({
      event: 'notification.metric',
      metric: 'notifications_sent_total',
      value: 1,
      notificationId,
      eventId,
      orderId,
      correlationId,
      provider,
      attemptNumber,
      latencyMs,
    }));
  }

  recordDelivered(notificationId: string, eventId: string, orderId: string | null, correlationId: string, provider: string): void {
    this.logger.log(JSON.stringify({
      event: 'notification.metric',
      metric: 'notifications_delivered_total',
      value: 1,
      notificationId,
      eventId,
      orderId,
      correlationId,
      provider,
    }));
  }

  recordFailed(notificationId: string, eventId: string, orderId: string | null, correlationId: string, provider: string, attemptNumber: number, errorKind: string, permanent: boolean): void {
    this.logger.error(JSON.stringify({
      event: 'notification.metric',
      metric: 'notifications_failed_total',
      value: 1,
      notificationId,
      eventId,
      orderId,
      correlationId,
      provider,
      attemptNumber,
      errorKind,
      permanent,
      alert: permanent,
    }));
  }

  recordRetry(notificationId: string, correlationId: string, attemptNumber: number, delayMs: number): void {
    this.logger.warn(JSON.stringify({
      event: 'notification.metric',
      metric: 'notification_retry_total',
      value: 1,
      notificationId,
      correlationId,
      attemptNumber,
      delayMs,
    }));
  }

  recordDeliveryDuration(notificationId: string, channel: string, provider: string, latencyMs: number): void {
    this.logger.log(JSON.stringify({
      event: 'notification.metric',
      metric: 'notification_delivery_duration_ms',
      value: latencyMs,
      notificationId,
      channel,
      provider,
    }));
  }

  async recordBacklogMetrics(): Promise<void> {
    const repo = this.dataSource.getRepository(NotificationEntity);

    const [pendingCount] = (await repo.query(
      "SELECT COUNT(*) AS cnt FROM `notifications` WHERE `status` IN ('PENDING', 'SENDING')",
    )) as Array<{ cnt: string }>;

    const [oldest] = (await repo.query(
      "SELECT MIN(`created_at`) AS oldest FROM `notifications` WHERE `status` IN ('PENDING', 'SENDING')",
    )) as Array<{ oldest: Date | null }>;

    const count = Number(pendingCount.cnt);
    const oldestAgeMs = oldest.oldest ? Date.now() - new Date(oldest.oldest).getTime() : 0;

    this.logger.log(JSON.stringify({
      event: 'notification.metric',
      metric: 'notification_pending_count',
      value: count,
    }));

    this.logger.log(JSON.stringify({
      event: 'notification.metric',
      metric: 'notification_oldest_pending_age_ms',
      value: oldestAgeMs,
    }));

    if (count > 500) {
      this.logger.error(JSON.stringify({
        event: 'notification.backlog_alert',
        pendingCount: count,
        oldestAgeMs,
        alert: true,
      }));
    }
  }
}
