import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface StaleWorkflowReport {
  overdueSteps: number;
  sagasStuckInPending: number;
  sagasStuckInCompensating: number;
  paymentOperationsUnknown: number;
  stuckInventoryReservations: number;
  outboxEventsExceededThreshold: number;
}

@Injectable()
export class StaleWorkflowDetector {
  private readonly logger = new Logger(StaleWorkflowDetector.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Runs all stale-workflow queries in parallel and returns a summary report.
   * All queries use indexed columns and bounded result sets.
   */
  async detect(opts: {
    stepOverdueThresholdMs?: number;
    sagaPendingThresholdMs?: number;
    compensatingThresholdMs?: number;
    inventoryStuckThresholdMs?: number;
    outboxRetryThreshold?: number;
    batchSize?: number;
  } = {}): Promise<StaleWorkflowReport> {
    const {
      stepOverdueThresholdMs = 60_000,
      sagaPendingThresholdMs = 120_000,
      compensatingThresholdMs = 300_000,
      inventoryStuckThresholdMs = 3_600_000,
      outboxRetryThreshold = 8,
      batchSize = 500,
    } = opts;

    const now = Date.now();
    const stepCutoff = new Date(now - stepOverdueThresholdMs);
    const pendingCutoff = new Date(now - sagaPendingThresholdMs);
    const compensatingCutoff = new Date(now - compensatingThresholdMs);
    const inventoryCutoff = new Date(now - inventoryStuckThresholdMs);

    const [
      overdueSteps,
      sagasStuckInPending,
      sagasStuckInCompensating,
      paymentOperationsUnknown,
      stuckInventoryReservations,
      outboxEventsExceededThreshold,
    ] = await Promise.all([
      // 1. Overdue saga steps — uses idx_saga_steps_recovery_deadline
      this.count(
        "SELECT COUNT(*) AS `n` FROM `saga_steps` WHERE `status` = 'IN_PROGRESS' AND `deadline_at` IS NOT NULL AND `deadline_at` <= ? LIMIT ?",
        [stepCutoff, batchSize],
      ),

      // 2. Sagas stuck in PENDING states — uses idx_order_sagas_recovery
      this.count(
        "SELECT COUNT(*) AS `n` FROM `order_sagas` WHERE `state` IN ('INVENTORY_RESERVATION_PENDING', 'PAYMENT_PENDING', 'CONFIRMATION_PENDING') AND `updated_at` < ? LIMIT ?",
        [pendingCutoff, batchSize],
      ),

      // 3. Sagas stuck in COMPENSATING — uses idx_order_sagas_recovery
      this.count(
        "SELECT COUNT(*) AS `n` FROM `order_sagas` WHERE `state` IN ('COMPENSATING', 'COMPENSATION_PENDING') AND `updated_at` < ? LIMIT ?",
        [compensatingCutoff, batchSize],
      ),

      // 4. Payment operations in UNKNOWN — uses idx_payment_operations_reconciliation
      this.count(
        "SELECT COUNT(*) AS `n` FROM `payment_operations` WHERE `operation_status` IN ('UNKNOWN', 'REQUIRES_RECONCILIATION') AND (`next_reconciliation_at` IS NULL OR `next_reconciliation_at` <= UTC_TIMESTAMP(6)) LIMIT ?",
        [batchSize],
      ),

      // 5. Inventory reservations held beyond expected duration
      this.count(
        "SELECT COUNT(*) AS `n` FROM `inventory_reservations` WHERE `status` = 'RESERVED' AND `created_at` < ? LIMIT ?",
        [inventoryCutoff, batchSize],
      ),

      // 6. Outbox events that have exceeded retry threshold
      this.count(
        'SELECT COUNT(*) AS `n` FROM `outbox_events` WHERE `failed_at` IS NOT NULL AND `attempts` >= ? LIMIT ?',
        [outboxRetryThreshold, batchSize],
      ),
    ]);

    const report: StaleWorkflowReport = {
      overdueSteps,
      sagasStuckInPending,
      sagasStuckInCompensating,
      paymentOperationsUnknown,
      stuckInventoryReservations,
      outboxEventsExceededThreshold,
    };

    if (Object.values(report).some((v) => v > 0)) {
      this.logger.warn(
        JSON.stringify({ event: 'saga.stale_workflow.report', ...report }),
      );
    }

    return report;
  }

  private async count(sql: string, params: unknown[]): Promise<number> {
    try {
      const [row] = (await this.dataSource.query(sql, params)) as Array<{
        n: number | string;
      }>;
      return Number(row?.n ?? 0);
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'saga.stale_workflow.query_failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return 0;
    }
  }
}
