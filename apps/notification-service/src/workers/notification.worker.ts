import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { NotificationsRepository } from '../notifications/notifications.repository';

@Injectable()
export class NotificationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationWorker.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly repository: NotificationsRepository,
    private readonly delivery: NotificationDeliveryService,
    config: ConfigService,
  ) {
    this.intervalMs = Number(config.get<string>('NOTIFICATION_WORKER_INTERVAL_MS') ?? '5000');
    this.batchSize = Number(config.get<string>('NOTIFICATION_WORKER_BATCH_SIZE') ?? '20');
    this.leaseMs = Number(config.get<string>('NOTIFICATION_WORKER_LEASE_MS') ?? '60000');
  }

  onModuleInit(): void {
    void this.tick();
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
    this.running = this.process().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async process(): Promise<void> {
    let batch: Awaited<ReturnType<NotificationsRepository['claimPendingBatch']>>;
    try {
      batch = await this.repository.claimPendingBatch(this.batchSize, this.leaseMs);
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'notification.worker.claim_failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }

    for (const notification of batch.notifications) {
      if (this.stopped) return;
      await this.delivery.deliver(notification);
    }

    if (batch.notifications.length > 0) {
      this.logger.log(
        JSON.stringify({
          event: 'notification.worker.batch_processed',
          count: batch.notifications.length,
        }),
      );
    }
  }
}
