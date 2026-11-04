import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { NotificationAttemptEntity } from './entities/notification-attempt.entity';
import { NotificationEntity } from './entities/notification.entity';
import {
  DeliveryAttemptStatus,
  NotificationChannel,
  NotificationStatus,
} from './notification-status.enum';
import {
  EMAIL_PROVIDER,
  SMS_PROVIDER,
  PUSH_PROVIDER,
  NotificationProviderError,
  type EmailProvider,
  type SmsProvider,
  type PushProvider,
  type SendEmailResult,
  type SendSmsResult,
  type SendPushResult,
} from '../providers/notification-provider.interface';
import { NotificationsRepository } from './notifications.repository';
import { NotificationMetricsService } from '../common/notification-metrics.service';
import { redactAddress } from '../common/utils/redaction.util';

type ProviderResult = SendEmailResult | SendSmsResult | SendPushResult;

// Retry schedule: attempt 1=immediate, 2=30s, 3=2m, 4=10m, 5=30m
const RETRY_DELAYS_MS = [0, 30_000, 120_000, 600_000, 1_800_000];

@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);
  private readonly maxAttempts: number;

  constructor(
    private readonly repository: NotificationsRepository,
    private readonly dataSource: DataSource,
    private readonly metrics: NotificationMetricsService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
    @Inject(SMS_PROVIDER) private readonly smsProvider: SmsProvider,
    @Inject(PUSH_PROVIDER) private readonly pushProvider: PushProvider,
    config: ConfigService,
  ) {
    this.maxAttempts = Number(config.get<string>('NOTIFICATION_MAX_ATTEMPTS') ?? '5');
  }

  async deliver(notification: NotificationEntity): Promise<void> {
    const startedAt = Date.now();
    let providerResult: ProviderResult | null = null;

    try {
      providerResult = await this.callProvider(notification);
      const latencyMs = Date.now() - startedAt;

      await this.repository.markSent(notification.id, providerResult.providerMessageId);
      await this.recordAttempt(notification, DeliveryAttemptStatus.SUCCEEDED, providerResult, null, null);

      this.metrics.recordSent(
        notification.id,
        notification.eventId,
        notification.orderId,
        notification.correlationId,
        providerResult.providerName,
        notification.retryCount + 1,
        latencyMs,
      );
      this.metrics.recordDeliveryDuration(notification.id, notification.channel, providerResult.providerName, latencyMs);

      this.logger.log(JSON.stringify({
        event: 'notification.sent',
        notificationId: notification.id,
        eventId: notification.eventId,
        orderId: notification.orderId,
        correlationId: notification.correlationId,
        channel: notification.channel,
        provider: providerResult.providerName,
        attemptNumber: notification.retryCount + 1,
        latencyMs,
        to: redactAddress(notification.recipientAddress),
      }));
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const providerName = this.providerNameFor(notification.channel);
      const errorKind = error instanceof NotificationProviderError ? error.kind : 'UNKNOWN';
      const errorMsg = error instanceof Error ? error.message : String(error);
      const permanent = this.isPermanent(error);

      // TIMEOUT is uncertain — provider may have accepted the message
      // Mark as FAILED for now; a future reconciliation pass can resolve it
      const finalStatus = permanent
        ? (errorKind === 'REJECTED' ? NotificationStatus.REJECTED : NotificationStatus.FAILED)
        : undefined;

      await this.recordAttempt(notification, DeliveryAttemptStatus.FAILED, null, errorKind, errorMsg);

      if (permanent) {
        await this.repository.markFailed(notification.id, errorMsg, finalStatus!);
        this.metrics.recordFailed(
          notification.id, notification.eventId, notification.orderId,
          notification.correlationId, providerName,
          notification.retryCount + 1, errorKind, true,
        );
        this.logger.error(JSON.stringify({
          event: 'notification.delivery_failed_permanent',
          notificationId: notification.id,
          eventId: notification.eventId,
          orderId: notification.orderId,
          correlationId: notification.correlationId,
          provider: providerName,
          attemptNumber: notification.retryCount + 1,
          errorKind,
          latencyMs,
          alert: errorKind === 'AUTHENTICATION',
        }));
        return;
      }

      const nextAttempt = notification.retryCount + 1;
      if (nextAttempt >= this.maxAttempts) {
        await this.repository.markFailed(notification.id, errorMsg, NotificationStatus.FAILED);
        this.metrics.recordFailed(
          notification.id, notification.eventId, notification.orderId,
          notification.correlationId, providerName, nextAttempt, errorKind, false,
        );
        this.logger.error(JSON.stringify({
          event: 'notification.delivery_exhausted',
          notificationId: notification.id,
          eventId: notification.eventId,
          orderId: notification.orderId,
          correlationId: notification.correlationId,
          provider: providerName,
          attempts: nextAttempt,
          errorKind,
          alert: true,
        }));
        return;
      }

      // Use provider's Retry-After if available, else scheduled backoff with jitter
      const baseDelay = RETRY_DELAYS_MS[Math.min(nextAttempt, RETRY_DELAYS_MS.length - 1)] ?? 1_800_000;
      const providerDelay = error instanceof NotificationProviderError ? (error.retryAfterMs ?? 0) : 0;
      const delay = providerDelay > 0
        ? providerDelay
        : Math.floor(baseDelay * (0.75 + Math.random() * 0.5));

      await this.repository.scheduleRetry(notification.id, delay, errorMsg, this.maxAttempts);
      this.metrics.recordRetry(notification.id, notification.correlationId, nextAttempt, delay);

      this.logger.warn(JSON.stringify({
        event: 'notification.delivery_retry_scheduled',
        notificationId: notification.id,
        eventId: notification.eventId,
        orderId: notification.orderId,
        correlationId: notification.correlationId,
        provider: providerName,
        attemptNumber: nextAttempt,
        delayMs: delay,
        errorKind,
        latencyMs,
      }));
    }
  }

  private async callProvider(notification: NotificationEntity): Promise<ProviderResult> {
    switch (notification.channel) {
      case NotificationChannel.EMAIL:
        return this.emailProvider.sendEmail({
          notificationId: notification.id,
          idempotencyKey: notification.idempotencyKey,
          to: notification.recipientAddress,
          subject: notification.subject,
          body: notification.body,
        });
      case NotificationChannel.SMS:
        return this.smsProvider.sendSms({
          notificationId: notification.id,
          idempotencyKey: notification.idempotencyKey,
          to: notification.recipientAddress,
          body: notification.body,
        });
      case NotificationChannel.PUSH:
        return this.pushProvider.sendPush({
          notificationId: notification.id,
          idempotencyKey: notification.idempotencyKey,
          deviceToken: notification.recipientAddress,
          title: notification.subject,
          body: notification.body,
        });
    }
  }

  private isPermanent(error: unknown): boolean {
    if (!(error instanceof NotificationProviderError)) return false;
    return !error.retryable;
  }

  private providerNameFor(channel: NotificationChannel): string {
    switch (channel) {
      case NotificationChannel.EMAIL: return 'email-provider';
      case NotificationChannel.SMS: return 'sms-provider';
      case NotificationChannel.PUSH: return 'push-provider';
    }
  }

  private async recordAttempt(
    notification: NotificationEntity,
    status: DeliveryAttemptStatus,
    result: ProviderResult | null,
    errorCode: string | null,
    errorMessage: string | null,
  ): Promise<void> {
    await this.dataSource.getRepository(NotificationAttemptEntity).save({
      id: randomUUID(),
      notificationId: notification.id,
      attemptNumber: notification.retryCount + 1,
      channel: notification.channel,
      provider: result?.providerName ?? this.providerNameFor(notification.channel),
      status,
      providerMessageId: result?.providerMessageId ?? null,
      errorCode,
      errorMessage: errorMessage?.slice(0, 1000) ?? null,
      completedAt: new Date(),
    });
  }
}
