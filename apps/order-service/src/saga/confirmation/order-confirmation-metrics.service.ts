import { Injectable } from '@nestjs/common';

export type OrderConfirmationOutcome = 'confirmed' | 'duplicate';

export interface OrderConfirmationResult {
  outcome: OrderConfirmationOutcome;
  sagaId: string;
  confirmationEventId: string;
  inventoryReservationId: string;
}

export interface OrderConfirmationMetricSnapshot {
  attempts: number;
  successes: number;
  failures: number;
  duplicates: number;
  durationCount: number;
  durationTotalMs: number;
}

@Injectable()
export class OrderConfirmationMetricsService {
  private attempts = 0;
  private successes = 0;
  private failures = 0;
  private duplicates = 0;
  private durationCount = 0;
  private durationTotalMs = 0;

  recordOutcome(outcome: OrderConfirmationOutcome, durationMs: number): void {
    this.attempts += 1;
    this.durationCount += 1;
    this.durationTotalMs += durationMs;
    if (outcome === 'confirmed') {
      this.successes += 1;
    } else {
      this.duplicates += 1;
    }
  }

  recordFailure(durationMs: number): void {
    this.attempts += 1;
    this.failures += 1;
    this.durationCount += 1;
    this.durationTotalMs += durationMs;
  }

  getSnapshot(): OrderConfirmationMetricSnapshot {
    return {
      attempts: this.attempts,
      successes: this.successes,
      failures: this.failures,
      duplicates: this.duplicates,
      durationCount: this.durationCount,
      durationTotalMs: this.durationTotalMs,
    };
  }
}
