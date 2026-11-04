import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ReconciliationHistoryEntity,
  ReconciliationOutcome,
} from './entities/reconciliation-history.entity';
import {
  PaymentProviderError,
  type PaymentProviderResult,
} from '../providers/payment-provider.interface';

@Injectable()
export class ProviderStatusService {
  private readonly logger = new Logger(ProviderStatusService.name);

  constructor(
    @InjectRepository(ReconciliationHistoryEntity)
    private readonly history: Repository<ReconciliationHistoryEntity>,
  ) {}

  /**
   * Persists a reconciliation attempt outcome after the caller has already
   * queried the provider.  The caller (OperationsService) owns the provider
   * call; this service owns the audit trail.
   */
  async recordAttempt(
    operationId: string,
    attemptNumber: number,
    result: PaymentProviderResult | null,
    error: unknown,
  ): Promise<void> {
    const outcome = this.classifyOutcome(result, error);
    const entry = this.history.create({
      id: randomUUID(),
      operationId,
      attemptNumber,
      outcome,
      providerStatus: result?.status ?? null,
      providerReference: result?.providerReference ?? null,
      failureCode: result?.failureCode ?? this.errorCode(error),
      errorMessage: error instanceof Error ? error.message.slice(0, 1000) : null,
    });
    await this.history.save(entry);
    this.logger.log(
      JSON.stringify({
        event: 'payment.reconciliation.attempt_recorded',
        operationId,
        attemptNumber,
        outcome,
        providerStatus: entry.providerStatus,
      }),
    );
  }

  async getHistory(operationId: string): Promise<ReconciliationHistoryEntity[]> {
    return this.history.find({
      where: { operationId },
      order: { attemptedAt: 'ASC' },
    });
  }

  private classifyOutcome(
    result: PaymentProviderResult | null,
    error: unknown,
  ): ReconciliationOutcome {
    if (error !== null && error !== undefined) {
      if (
        error instanceof PaymentProviderError &&
        error.kind === 'AUTHENTICATION'
      ) {
        return ReconciliationOutcome.ESCALATED;
      }
      return ReconciliationOutcome.PROVIDER_ERROR;
    }
    if (!result) return ReconciliationOutcome.INCONCLUSIVE;
    if (result.status === 'SUCCEEDED' || result.status === 'DECLINED') {
      return ReconciliationOutcome.RESOLVED;
    }
    if (result.status === 'PROCESSING') return ReconciliationOutcome.STILL_PROCESSING;
    // UNKNOWN — provider could not determine status
    return ReconciliationOutcome.INCONCLUSIVE;
  }

  private errorCode(error: unknown): string | null {
    if (error instanceof PaymentProviderError) return error.kind;
    if (error instanceof Error) return error.name;
    return null;
  }
}
