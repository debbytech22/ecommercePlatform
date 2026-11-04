/**
 * The authoritative Saga recovery implementation lives in
 * ../services/saga-recovery.service.ts.
 *
 * This re-export exists so that any import from the saga/recovery path
 * resolves to the real service without duplication.
 */
export { SagaRecoveryService } from '../services/saga-recovery.service';
