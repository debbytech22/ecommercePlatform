import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

export enum DiscrepancyKind {
  /** Normal async processing lag — no action needed yet */
  EXPECTED_INTERMEDIATE = 'EXPECTED_INTERMEDIATE',
  /** Result event is in-flight or delayed — monitor */
  DELAYED_EVENT = 'DELAYED_EVENT',
  /** A downstream operation has failed — compensation may be needed */
  FAILED_OPERATION = 'FAILED_OPERATION',
  /** Compensation started but not completed */
  INCOMPLETE_COMPENSATION = 'INCOMPLETE_COMPENSATION',
  /** States are genuinely inconsistent — escalate */
  GENUINE_INCONSISTENCY = 'GENUINE_INCONSISTENCY',
}

export interface CrossServiceDiscrepancy {
  sagaId: string;
  orderId: string;
  sagaState: string;
  inventoryStatus: string | null;
  paymentStatus: string | null;
  kind: DiscrepancyKind;
  description: string;
}

interface DiscrepancyRow {
  saga_id: string;
  order_id: string;
  saga_state: string;
  inventory_status: string | null;
  payment_status: string | null;
  saga_updated_at: Date;
  compensation_started_at: Date | null;
}

/** Sagas older than this without resolution are candidates for cross-service check */
const STALE_THRESHOLD_MS = 120_000;

@Injectable()
export class CrossServiceReconciliationService {
  private readonly logger = new Logger(CrossServiceReconciliationService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Identifies cross-service discrepancies for sagas that have been in a
   * non-terminal state longer than STALE_THRESHOLD_MS.
   *
   * Does NOT modify any records — callers decide the resolution policy.
   */
  async detectDiscrepancies(
    batchSize = 50,
  ): Promise<CrossServiceDiscrepancy[]> {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

    const rows = (await this.dataSource.query(
      `SELECT
         s.\`id\`                      AS saga_id,
         s.\`order_id\`                AS order_id,
         s.\`state\`                   AS saga_state,
         s.\`inventory_reservation_status\` AS inventory_status,
         s.\`payment_status\`          AS payment_status,
         s.\`updated_at\`              AS saga_updated_at,
         s.\`compensation_started_at\` AS compensation_started_at
       FROM \`order_sagas\` s
       WHERE s.\`state\` NOT IN (
         'COMPLETED', 'COMPENSATED', 'FAILED'
       )
       AND s.\`updated_at\` < ?
       ORDER BY s.\`updated_at\` ASC
       LIMIT ?`,
      [cutoff, batchSize],
    )) as DiscrepancyRow[];

    const discrepancies: CrossServiceDiscrepancy[] = [];

    for (const row of rows) {
      const d = this.classify(row);
      if (d) {
        discrepancies.push(d);
        this.logger.warn(
          JSON.stringify({
            event: 'saga.cross_service.discrepancy_detected',
            sagaId: d.sagaId,
            orderId: d.orderId,
            sagaState: d.sagaState,
            inventoryStatus: d.inventoryStatus,
            paymentStatus: d.paymentStatus,
            kind: d.kind,
            description: d.description,
          }),
        );
      }
    }

    return discrepancies;
  }

  private classify(row: DiscrepancyRow): CrossServiceDiscrepancy | null {
    const base = {
      sagaId: row.saga_id,
      orderId: row.order_id,
      sagaState: row.saga_state,
      inventoryStatus: row.inventory_status,
      paymentStatus: row.payment_status,
    };

    const state = row.saga_state;
    const inv = row.inventory_status;
    const pay = row.payment_status;

    // PENDING saga with no downstream state — normal startup lag
    if (
      state === 'INVENTORY_RESERVATION_PENDING' &&
      inv === null &&
      pay === null
    ) {
      return {
        ...base,
        kind: DiscrepancyKind.EXPECTED_INTERMEDIATE,
        description: 'Saga awaiting first inventory reservation result',
      };
    }

    // Saga confirmed but inventory still RESERVED — inventory release discrepancy
    if (state === 'COMPLETED' && inv === 'RESERVED') {
      return {
        ...base,
        kind: DiscrepancyKind.GENUINE_INCONSISTENCY,
        description:
          'Saga completed but inventory reservation was never released or committed',
      };
    }

    // Compensating but inventory still RESERVED — incomplete compensation
    if (
      (state === 'COMPENSATING' || state === 'COMPENSATION_PENDING') &&
      inv === 'RESERVED'
    ) {
      return {
        ...base,
        kind: DiscrepancyKind.INCOMPLETE_COMPENSATION,
        description:
          'Compensation in progress but inventory has not been released yet',
      };
    }

    // Compensated but inventory still RESERVED — release discrepancy
    if (state === 'COMPENSATED' && inv === 'RESERVED') {
      return {
        ...base,
        kind: DiscrepancyKind.GENUINE_INCONSISTENCY,
        description:
          'Saga compensated but inventory reservation was never released',
      };
    }

    // Payment AUTHORIZED but saga stuck in PAYMENT_PENDING — delayed event
    if (state === 'PAYMENT_PENDING' && pay === 'AUTHORIZED') {
      return {
        ...base,
        kind: DiscrepancyKind.DELAYED_EVENT,
        description:
          'Payment authorized but saga has not received the result event',
      };
    }

    // Saga FAILED but payment AUTHORIZED and inventory RESERVED — needs compensation
    if (state === 'FAILED' && pay === 'AUTHORIZED' && inv === 'RESERVED') {
      return {
        ...base,
        kind: DiscrepancyKind.INCOMPLETE_COMPENSATION,
        description:
          'Saga failed but payment authorization and inventory reservation were not compensated',
      };
    }

    // Saga FAILED with payment UNKNOWN — needs reconciliation
    if (state === 'FAILED' && pay === null && inv === 'RESERVED') {
      return {
        ...base,
        kind: DiscrepancyKind.FAILED_OPERATION,
        description:
          'Saga failed with unknown payment status and held inventory',
      };
    }

    // MANUAL_INTERVENTION_REQUIRED — always flag
    if (state === 'MANUAL_INTERVENTION_REQUIRED') {
      return {
        ...base,
        kind: DiscrepancyKind.FAILED_OPERATION,
        description: 'Saga requires manual intervention',
      };
    }

    return null;
  }
}
