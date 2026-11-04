import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { OutboxEventEntity, NotificationOutboxStatus } from './entities/outbox-event.entity';
import { NotificationEventPublisher } from '../messaging/publishers/notification-event.publisher';

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly publisher: NotificationEventPublisher,
    config: ConfigService,
  ) {
    this.intervalMs = this.readPositiveInt(
      config.get<string>('NOTIFICATION_OUTBOX_POLL_INTERVAL_MS'),
      1_000,
    );
    this.batchSize = this.readPositiveInt(
      config.get<string>('NOTIFICATION_OUTBOX_BATCH_SIZE'),
      25,
    );
    this.maxAttempts = this.readPositiveInt(
      config.get<string>('NOTIFICATION_OUTBOX_MAX_ATTEMPTS'),
      10,
    );
  }

  onModuleInit(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.polling;
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = this.publishAvailable().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async publishAvailable(): Promise<void> {
    const claimToken = randomUUID();
    let events: OutboxEventEntity[];
    try {
      events = await this.claimBatch(claimToken);
    } catch (error) {
      this.logger.error(
        JSON.stringify({ event: 'notification.outbox.claim_failed', error: this.msg(error) }),
      );
      return;
    }

    for (const event of events) {
      if (this.stopped) return;
      try {
        await this.publisher.publish(event.payload);
        await this.dataSource.getRepository(OutboxEventEntity).update(
          { id: event.id, claimToken },
          { status: NotificationOutboxStatus.PUBLISHED, publishedAt: new Date(), lockedUntil: null, claimToken: null, lastError: null },
        );
      } catch (error) {
        const retryCount = event.retryCount + 1;
        const exhausted = retryCount >= this.maxAttempts;
        const delay = Math.min(300_000, 1_000 * 2 ** Math.min(event.retryCount, 8));
        const jittered = Math.floor(delay * (0.5 + Math.random()));
        await this.dataSource.getRepository(OutboxEventEntity).update(
          { id: event.id, claimToken },
          {
            retryCount,
            status: exhausted ? NotificationOutboxStatus.FAILED : NotificationOutboxStatus.PENDING,
            nextRetryAt: exhausted ? event.nextRetryAt : new Date(Date.now() + jittered),
            failedAt: exhausted ? new Date() : null,
            lastError: this.msg(error).slice(0, 1000),
            lockedUntil: null,
            claimToken: null,
          },
        );
        this.logger.error(
          JSON.stringify({
            event: exhausted ? 'notification.outbox.exhausted' : 'notification.outbox.retry_scheduled',
            eventId: event.eventId,
            error: this.msg(error),
          }),
        );
      }
    }
  }

  private async claimBatch(claimToken: string): Promise<OutboxEventEntity[]> {
    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        'SELECT `id` FROM `notification_outbox_events` WHERE `status` = ? AND `next_retry_at` <= NOW(6) AND (`locked_until` IS NULL OR `locked_until` <= NOW(6)) ORDER BY `created_at` LIMIT ? FOR UPDATE SKIP LOCKED',
        [NotificationOutboxStatus.PENDING, this.batchSize],
      )) as Array<{ id: string }>;
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const lockedUntil = new Date(Date.now() + 60_000);
      for (const id of ids) {
        await manager.update(OutboxEventEntity, { id, status: NotificationOutboxStatus.PENDING }, { claimToken, lockedUntil });
      }
      return manager.getRepository(OutboxEventEntity).find({
        where: ids.map((id) => ({ id, claimToken })),
        order: { createdAt: 'ASC' },
      });
    });
  }

  private readPositiveInt(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid config value: ${value}`);
    return n;
  }

  private msg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
