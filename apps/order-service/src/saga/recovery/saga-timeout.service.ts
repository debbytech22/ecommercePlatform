import { Injectable, Logger } from '@nestjs/common';
import { SagaRecoveryService } from '../services/saga-recovery.service';

@Injectable()
export class SagaTimeoutService {
  private readonly logger = new Logger(SagaTimeoutService.name);

  constructor(private readonly recovery: SagaRecoveryService) {}

  /**
   * Returns sagas whose last update is older than `olderThanMs` milliseconds
   * and are still in a non-terminal, non-compensating state.
   * Delegates to the existing findStaleSagas query on SagaRecoveryService.
   */
  async findTimedOutSagas(olderThanMs: number) {
    const cutoff = new Date(Date.now() - olderThanMs);
    const sagas = await this.recovery.findStaleSagas(cutoff);
    if (sagas.length > 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'saga.timeout.stale_sagas_found',
          count: sagas.length,
          olderThanMs,
        }),
      );
    }
    return sagas;
  }
}
