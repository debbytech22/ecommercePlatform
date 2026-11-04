import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentEventPublisher } from '../messaging/publishers/payment-event.publisher';
import { OutboxRepository } from './outbox.repository';

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
    private readonly repository: OutboxRepository,
    private readonly publisher: PaymentEventPublisher,
    config: ConfigService,
  ) {
    this.intervalMs = this.readPositiveInteger(
      config.get<string>('PAYMENT_OUTBOX_POLL_INTERVAL_MS'),
      1000,
      'PAYMENT_OUTBOX_POLL_INTERVAL_MS',
    );
    this.batchSize = this.readPositiveInteger(
      config.get<string>('PAYMENT_OUTBOX_BATCH_SIZE'),
      25,
      'PAYMENT_OUTBOX_BATCH_SIZE',
    );
    this.maxAttempts = this.readPositiveInteger(
      config.get<string>('PAYMENT_OUTBOX_MAX_ATTEMPTS'),
      10,
      'PAYMENT_OUTBOX_MAX_ATTEMPTS',
    );
    if (this.batchSize > 100) {
      throw new Error('PAYMENT_OUTBOX_BATCH_SIZE must not exceed 100');
    }
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

  async poll(): Promise<void> {
    if (this.stopped || this.polling) return this.polling;
    this.polling = this.publishAvailable().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async publishAvailable(): Promise<void> {
    let batch: Awaited<ReturnType<OutboxRepository['claimBatch']>>;
    try {
      batch = await this.repository.claimBatch(this.batchSize, 60_000);
    } catch (error) {
      this.logError('payment.outbox.claim_failed', error);
      return;
    }
    for (const event of batch.events) {
      if (this.stopped) return;
      try {
        await this.publisher.publish(event.payload);
        if (
          !(await this.repository.markPublished(event.id, batch.claimToken))
        ) {
          this.logger.error(
            JSON.stringify({
              event: 'payment.outbox.lost_claim_after_publish',
              eventId: event.eventId,
            }),
          );
        }
      } catch (error) {
        const backoffDelay = Math.min(
          300_000,
          1000 * 2 ** Math.min(event.retryCount, 8),
        );
        const delay = Math.min(
          300_000,
          Math.floor(backoffDelay * (0.5 + Math.random())),
        );
        try {
          const result = await this.repository.scheduleRetry(
            event.id,
            batch.claimToken,
            delay,
            this.errorMessage(error),
            this.maxAttempts,
          );
          this.logger.error(
            JSON.stringify({
              event: `payment.outbox.${result === 'scheduled' ? 'retry_scheduled' : result}`,
              eventId: event.eventId,
              eventType: event.eventType,
              retryCount: event.retryCount + 1,
              error: this.errorMessage(error),
            }),
          );
        } catch (retryError) {
          this.logError('payment.outbox.retry_schedule_failed', retryError, {
            eventId: event.eventId,
          });
        }
      }
    }
  }

  private readPositiveInteger(
    configured: string | undefined,
    fallback: number,
    name: string,
  ): number {
    if (configured === undefined) return fallback;
    const value = Number(configured);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
  }

  private logError(
    event: string,
    error: unknown,
    metadata: Record<string, unknown> = {},
  ): void {
    this.logger.error(
      JSON.stringify({
        event,
        ...metadata,
        error: this.errorMessage(error),
      }),
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
