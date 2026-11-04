import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReconciliationService } from './reconciliation.service';

@Injectable()
export class ReconciliationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationWorker.name);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly reconciliation: ReconciliationService,
    config: ConfigService,
  ) {
    const configured = config.get<string>('PAYMENT_RECONCILIATION_INTERVAL_MS');
    this.intervalMs = configured === undefined ? 5000 : Number(configured);
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 250) {
      throw new Error(
        'PAYMENT_RECONCILIATION_INTERVAL_MS must be an integer of at least 250',
      );
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
    await this.running;
  }

  async poll(): Promise<void> {
    if (this.stopped || this.running) return this.running;
    this.running = this.reconciliation
      .reconcile()
      .then((attempted) => {
        if (attempted > 0) {
          this.logger.log(
            JSON.stringify({
              event: 'payment.reconciliation.batch_completed',
              attempted,
            }),
          );
        }
      })
      .catch((error: unknown) => {
        this.logger.error(
          JSON.stringify({
            event: 'payment.reconciliation.batch_failed',
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
