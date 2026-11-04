import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OperationsService } from '../operations/operations.service';

@Injectable()
export class ReconciliationService {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly alertBacklogThreshold: number;

  constructor(
    private readonly operations: OperationsService,
    config: ConfigService,
  ) {
    this.batchSize = this.readPositiveInteger(
      config.get<string>('PAYMENT_RECONCILIATION_BATCH_SIZE'),
      20,
      'PAYMENT_RECONCILIATION_BATCH_SIZE',
    );
    this.maxAttempts = this.readPositiveInteger(
      config.get<string>('PAYMENT_RECONCILIATION_MAX_ATTEMPTS'),
      8,
      'PAYMENT_RECONCILIATION_MAX_ATTEMPTS',
    );
    this.alertBacklogThreshold = this.readPositiveInteger(
      config.get<string>('PAYMENT_RECONCILIATION_ALERT_BACKLOG'),
      100,
      'PAYMENT_RECONCILIATION_ALERT_BACKLOG',
    );
    if (this.batchSize > 100) {
      throw new Error('PAYMENT_RECONCILIATION_BATCH_SIZE must not exceed 100');
    }
  }

  async reconcile(): Promise<number> {
    return this.operations.reconcilePendingOperations(
      this.batchSize,
      this.maxAttempts,
      this.alertBacklogThreshold,
    );
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
}
