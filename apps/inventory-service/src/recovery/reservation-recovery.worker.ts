import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReservationRecoveryService } from './reservation-recovery.service';

@Injectable()
export class ReservationRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservationRecoveryWorker.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly recovery: ReservationRecoveryService,
    config: ConfigService,
  ) {
    const interval = config.get<string>('RESERVATION_RECOVERY_INTERVAL_MS');
    this.intervalMs = interval === undefined ? 10_000 : Number(interval);
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 250) {
      throw new Error('RESERVATION_RECOVERY_INTERVAL_MS must be an integer of at least 250');
    }
    const batch = config.get<string>('RESERVATION_RECOVERY_BATCH_SIZE');
    this.batchSize = batch === undefined ? 20 : Number(batch);
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

  private async poll(): Promise<void> {
    if (this.stopped || this.running) return this.running;
    this.running = this.recovery
      .recoverStuckReservations(this.batchSize)
      .then((recovered) => {
        if (recovered > 0) {
          this.logger.log(JSON.stringify({ event: 'reservation.recovery.batch_completed', recovered }));
        }
      })
      .catch((error: unknown) => {
        this.logger.error(
          JSON.stringify({
            event: 'reservation.recovery.batch_failed',
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
