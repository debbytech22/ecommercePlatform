import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { NotificationEntity } from '../notifications/entities/notification.entity';
import { NotificationStatus } from '../notifications/notification-status.enum';
import { NotificationsRepository } from '../notifications/notifications.repository';

@Injectable()
export class NotificationRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationRecoveryWorker.name);
  private readonly intervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly repository: NotificationsRepository,
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.intervalMs = Number(config.get<string>('NOTIFICATION_RECOVERY_INTERVAL_MS') ?? '60000');
    this.staleThresholdMs = Number(config.get<string>('NOTIFICATION_STALE_THRESHOLD_MS') ?? '120000');
    this.batchSize = Number(config.get<string>('NOTIFICATION_RECOVERY_BATCH_SIZE') ?? '50');
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = this.recover().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async recover(): Promise<void> {
    try {
      const stale = await this.repository.findStaleNotifications(
        this.staleThresholdMs,
        this.batchSize,
      );
      if (stale.length === 0) return;

      for (const notification of stale) {
        await this.dataSource.getRepository(NotificationEntity).update(
          { id: notification.id, status: NotificationStatus.SENDING },
          { status: NotificationStatus.PENDING, nextRetryAt: new Date() },
        );
      }

      this.logger.warn(
        JSON.stringify({
          event: 'notification.recovery.stale_reset',
          count: stale.length,
        }),
      );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'notification.recovery.failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
