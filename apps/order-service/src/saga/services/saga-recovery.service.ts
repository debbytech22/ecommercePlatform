import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { OrderStatus } from '../../entities/order.entity';
import { SagaState } from '../enums/saga-state.enum';
import { SagaStepStatus } from '../enums/saga-step-status.enum';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaStepEntity, SagaStepType } from '../entities/saga-step.entity';
import { SagaCompensationService } from './saga-compensation.service';
import { OrderConfirmationMetricsService } from '../confirmation/order-confirmation-metrics.service';
import {
  SAGA_TIMEOUT_CONFIG,
  type SagaTimeoutConfig,
} from '../config/saga-timeout.config';
import { OrderQueryMetricsService } from '../../orders/queries/order-query-metrics.service';

const RECOVERY_POLL_INTERVAL_MS = 15_000;
const RECOVERY_BATCH_SIZE = 100;
const MAX_TIMEOUT_RECOVERIES = 3;

const RESULT_TYPES: Readonly<Record<SagaStepType, readonly string[]>> = {
  [SagaStepType.INVENTORY_RESERVATION]: [
    'inventory.reserved.v1',
    'inventory.reservation_failed.v1',
  ],
  [SagaStepType.PAYMENT_AUTHORIZATION]: [
    'payment.authorized.v1',
    'payment.authorization_failed.v1',
    'payment.authorization_uncertain.v1',
  ],
  [SagaStepType.PAYMENT_RECONCILIATION]: ['payment.reconciled.v1'],
  [SagaStepType.PAYMENT_VOID]: ['payment.voided.v1', 'payment.void_failed.v1'],
  [SagaStepType.PAYMENT_REFUND]: [
    'payment.refunded.v1',
    'payment.refund_failed.v1',
  ],
  [SagaStepType.INVENTORY_RELEASE]: [
    'inventory.released.v1',
    'inventory.release_failed.v1',
  ],
};

interface OverdueStepRow {
  step_id: string;
  saga_id: string;
  order_id: string;
  state: SagaState;
  step_type: SagaStepType;
  command_id: string | null;
  attempts: number;
  correlation_id: string;
  payment_operation_id: string | null;
  failure_code: string | null;
}

interface OrderStatusRow {
  status: OrderStatus;
}

interface OutboxStatusRow {
  id: string;
  event_type: string;
  published_at: Date | null;
  failed_at: Date | null;
}

export interface SagaRecoveryMetrics {
  activeSagas: number;
  failedSagas: number;
  overdueSteps: number;
  compensationSucceeded: number;
  compensationFailed: number;
  averageExecutionDurationSeconds: number;
  ordersWaitingForConfirmation: number;
  successfulResultsAwaitingConfirmation: number;
  pendingConfirmationEvents: number;
  failedConfirmationEvents: number;
  confirmationAttempts: number;
  confirmationSuccesses: number;
  confirmationFailures: number;
  duplicateConfirmationAttempts: number;
  confirmationDurationCount: number;
  confirmationDurationTotalMs: number;
  compensationInitiations: number;
  compensationPendingSteps: number;
  compensationRetryAttempts: number;
  compensationOldestAgeSeconds: number;
  compensationManualInterventions: number;
  compensationStepDurationSeconds: Record<string, number>;
}

@Injectable()
export class SagaRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SagaRecoveryService.name);
  private readonly pollIntervalMs: number;
  private readonly metricsHost: string;
  private readonly metricsPort: number;
  private timer: NodeJS.Timeout | undefined;
  private activeRecovery: Promise<void> | undefined;
  private metricsServer: Server | undefined;
  private stopping = false;

  constructor(
    @InjectRepository(OrderSagaEntity)
    private readonly sagas: Repository<OrderSagaEntity>,
    private readonly dataSource: DataSource,
    private readonly compensation: SagaCompensationService,
    private readonly config: ConfigService,
    private readonly confirmationMetrics: OrderConfirmationMetricsService,
    private readonly orderQueryMetrics: OrderQueryMetricsService,
    @Inject(SAGA_TIMEOUT_CONFIG)
    private readonly timeouts: SagaTimeoutConfig,
  ) {
    this.pollIntervalMs = this.readPositiveInteger(
      'SAGA_RECOVERY_POLL_INTERVAL_MS',
      RECOVERY_POLL_INTERVAL_MS,
    );
    this.metricsHost = this.config.get<string>(
      'SAGA_METRICS_HOST',
      '127.0.0.1',
    );
    this.metricsPort = this.readPositiveInteger('SAGA_METRICS_PORT', 9465);
  }

  onModuleInit(): void {
    this.startMetricsServer();
    void this.recoverOverdueSteps();
    this.timer = setInterval(() => {
      void this.recoverOverdueSteps();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.activeRecovery;
    await this.stopMetricsServer();
  }

  findStaleSagas(olderThan: Date): Promise<OrderSagaEntity[]> {
    return this.sagas
      .createQueryBuilder('saga')
      .leftJoinAndSelect('saga.steps', 'step')
      .where('saga.currentState IN (:...states)', {
        states: [
          SagaState.INVENTORY_RESERVATION_PENDING,
          SagaState.PAYMENT_PENDING,
          SagaState.CONFIRMATION_PENDING,
          SagaState.COMPENSATING,
          SagaState.COMPENSATION_PENDING,
          SagaState.MANUAL_INTERVENTION_REQUIRED,
        ],
      })
      .andWhere('saga.updatedAt < :olderThan', { olderThan })
      .orderBy('saga.updatedAt', 'ASC')
      .getMany();
  }

  getSagaByOrderId(orderId: string): Promise<OrderSagaEntity | null> {
    return this.sagas
      .createQueryBuilder('saga')
      .leftJoinAndSelect('saga.steps', 'step')
      .where('saga.orderId = :orderId', { orderId })
      .getOne();
  }

  async requestPaymentReconciliation(orderId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const saga = await manager
        .getRepository(OrderSagaEntity)
        .createQueryBuilder('saga')
        .setLock('pessimistic_write')
        .where('saga.orderId = :orderId', { orderId })
        .getOne();
      if (!saga) throw new Error(`No Saga exists for order ${orderId}`);
      if (
        saga.currentState !== SagaState.MANUAL_INTERVENTION_REQUIRED ||
        !saga.paymentOperationId
      ) {
        throw new Error(
          `Saga ${saga.id} has no unresolved payment operation to reconcile`,
        );
      }

      const step = await manager.getRepository(SagaStepEntity).findOneByOrFail({
        sagaId: saga.id,
        stepType: SagaStepType.PAYMENT_RECONCILIATION,
      });
      const authorizationStep = await manager
        .getRepository(SagaStepEntity)
        .findOneByOrFail({
          sagaId: saga.id,
          stepType: SagaStepType.PAYMENT_AUTHORIZATION,
        });
      step.status = SagaStepStatus.PENDING;
      step.commandId = null;
      step.deadlineAt = null;
      step.completedAt = null;
      await manager.getRepository(SagaStepEntity).save(step);
      await this.compensation.requestPaymentReconciliation(
        manager,
        saga,
        authorizationStep.commandId ?? saga.correlationId,
      );
    });
  }

  async getMetrics(): Promise<SagaRecoveryMetrics> {
    const [row] = (await this.dataSource.query(
      "SELECT (SELECT COUNT(*) FROM `order_sagas` WHERE `state` NOT IN ('COMPLETED', 'COMPENSATED', 'FAILED')) AS `active_sagas`, (SELECT COUNT(*) FROM `order_sagas` WHERE `state` IN ('FAILED', 'MANUAL_INTERVENTION_REQUIRED')) AS `failed_sagas`, (SELECT COUNT(*) FROM `saga_steps` WHERE `status` = 'IN_PROGRESS' AND `deadline_at` <= UTC_TIMESTAMP(6)) AS `overdue_steps`, (SELECT COUNT(*) FROM `saga_steps` WHERE `step_type` IN ('PAYMENT_VOID', 'PAYMENT_REFUND', 'INVENTORY_RELEASE') AND `status` IN ('SUCCEEDED', 'COMPENSATED')) AS `compensation_succeeded`, (SELECT COUNT(*) FROM `saga_steps` WHERE `step_type` IN ('PAYMENT_VOID', 'PAYMENT_REFUND', 'INVENTORY_RELEASE') AND `status` = 'MANUAL_INTERVENTION_REQUIRED') AS `compensation_failed`, (SELECT COALESCE(AVG(TIMESTAMPDIFF(MICROSECOND, `started_at`, `completed_at`)) / 1000000, 0) FROM `order_sagas` WHERE `completed_at` IS NOT NULL) AS `average_duration_seconds`, (SELECT COUNT(*) FROM `order_sagas` `s` INNER JOIN `orders` `o` ON `o`.`id` = `s`.`order_id` WHERE `s`.`state` = 'PAYMENT_PENDING' AND `o`.`status` = 'PROCESSING_PAYMENT') AS `orders_waiting_for_confirmation`, (SELECT COUNT(*) FROM `order_sagas` `s` INNER JOIN `orders` `o` ON `o`.`id` = `s`.`order_id` INNER JOIN `saga_steps` `i` ON `i`.`saga_id` = `s`.`id` AND `i`.`step_type` = 'INVENTORY_RESERVATION' AND `i`.`status` = 'SUCCEEDED' INNER JOIN `saga_steps` `p` ON `p`.`saga_id` = `s`.`id` AND `p`.`step_type` = 'PAYMENT_AUTHORIZATION' AND `p`.`status` = 'SUCCEEDED' LEFT JOIN `outbox_events` `oe` ON `oe`.`id` = `s`.`id` AND `oe`.`event_type` = 'order.confirmed.v1' WHERE `s`.`state` IN ('PAYMENT_AUTHORIZED', 'CONFIRMATION_PENDING') AND `o`.`status` = 'PROCESSING_PAYMENT' AND `oe`.`id` IS NULL) AS `successful_results_awaiting_confirmation`, (SELECT COUNT(*) FROM `outbox_events` WHERE `event_type` = 'order.confirmed.v1' AND `published_at` IS NULL AND `failed_at` IS NULL) AS `pending_confirmation_events`, (SELECT COUNT(*) FROM `outbox_events` WHERE `event_type` = 'order.confirmed.v1' AND `failed_at` IS NOT NULL) AS `failed_confirmation_events`, (SELECT COUNT(*) FROM `order_sagas` WHERE `compensation_started_at` IS NOT NULL) AS `compensation_initiations`, (SELECT COUNT(*) FROM `saga_steps` WHERE `step_type` IN ('PAYMENT_VOID', 'PAYMENT_REFUND', 'INVENTORY_RELEASE') AND `status` IN ('PENDING', 'IN_PROGRESS')) AS `compensation_pending_steps`, (SELECT COALESCE(SUM(GREATEST(`attempts` - 1, 0)), 0) FROM `saga_steps` WHERE `step_type` IN ('PAYMENT_VOID', 'PAYMENT_REFUND', 'INVENTORY_RELEASE')) AS `compensation_retry_attempts`, (SELECT COALESCE(MAX(TIMESTAMPDIFF(SECOND, `compensation_started_at`, UTC_TIMESTAMP(6))), 0) FROM `order_sagas` WHERE `compensation_started_at` IS NOT NULL AND `compensation_status` <> 'COMPLETED') AS `compensation_oldest_age_seconds`, (SELECT COUNT(*) FROM `order_sagas` WHERE `compensation_status` = 'MANUAL_INTERVENTION_REQUIRED') AS `compensation_manual_interventions`",
    )) as Array<Record<string, number | string>>;
    const durationRows = (await this.dataSource.query(
      "SELECT `step_type`, COALESCE(AVG(TIMESTAMPDIFF(MICROSECOND, `started_at`, `completed_at`)) / 1000000, 0) AS `duration_seconds` FROM `saga_steps` WHERE `step_type` IN ('INVENTORY_RELEASE', 'PAYMENT_VOID', 'PAYMENT_REFUND') AND `started_at` IS NOT NULL AND `completed_at` IS NOT NULL AND `status` IN ('SUCCEEDED', 'COMPENSATED') GROUP BY `step_type`",
    )) as Array<{ step_type: string; duration_seconds: number | string }>;

    const confirmation = this.confirmationMetrics.getSnapshot();
    return {
      activeSagas: Number(row.active_sagas),
      failedSagas: Number(row.failed_sagas),
      overdueSteps: Number(row.overdue_steps),
      compensationSucceeded: Number(row.compensation_succeeded),
      compensationFailed: Number(row.compensation_failed),
      averageExecutionDurationSeconds: Number(row.average_duration_seconds),
      ordersWaitingForConfirmation: Number(row.orders_waiting_for_confirmation),
      successfulResultsAwaitingConfirmation: Number(
        row.successful_results_awaiting_confirmation,
      ),
      pendingConfirmationEvents: Number(row.pending_confirmation_events),
      failedConfirmationEvents: Number(row.failed_confirmation_events),
      confirmationAttempts: confirmation.attempts,
      confirmationSuccesses: confirmation.successes,
      confirmationFailures: confirmation.failures,
      duplicateConfirmationAttempts: confirmation.duplicates,
      confirmationDurationCount: confirmation.durationCount,
      confirmationDurationTotalMs: confirmation.durationTotalMs,
      compensationInitiations: Number(row.compensation_initiations),
      compensationPendingSteps: Number(row.compensation_pending_steps),
      compensationRetryAttempts: Number(row.compensation_retry_attempts),
      compensationOldestAgeSeconds: Number(row.compensation_oldest_age_seconds),
      compensationManualInterventions: Number(
        row.compensation_manual_interventions,
      ),
      compensationStepDurationSeconds: Object.fromEntries(
        durationRows.map(({ step_type, duration_seconds }) => [
          step_type,
          Number(duration_seconds),
        ]),
      ),
    };
  }

  async recoverOverdueSteps(): Promise<void> {
    if (this.stopping || this.activeRecovery) return this.activeRecovery;
    this.activeRecovery = this.recoverBatch().finally(() => {
      this.activeRecovery = undefined;
    });
    return this.activeRecovery;
  }

  private async recoverBatch(): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      const overdue = (await runner.query(
        "SELECT step.`id` AS `step_id`, saga.`id` AS `saga_id`, saga.`order_id`, saga.`state`, step.`step_type`, step.`command_id`, step.`attempts`, saga.`correlation_id`, saga.`payment_operation_id`, saga.`failure_code` FROM `saga_steps` step INNER JOIN `order_sagas` saga ON saga.`id` = step.`saga_id` WHERE step.`status` = 'IN_PROGRESS' AND step.`deadline_at` IS NOT NULL AND step.`deadline_at` <= UTC_TIMESTAMP(6) ORDER BY step.`deadline_at` ASC LIMIT ? FOR UPDATE SKIP LOCKED",
        [RECOVERY_BATCH_SIZE],
      )) as OverdueStepRow[];
      for (const step of overdue) {
        await this.recoverStep(runner, step);
      }
      await runner.commitTransaction();
      if (overdue.length > 0) {
        this.logger.warn(
          JSON.stringify({
            event: 'saga.recovery.batch_completed',
            overdueSteps: overdue.length,
          }),
        );
      }
    } catch (error) {
      if (runner.isTransactionActive) {
        try {
          await runner.rollbackTransaction();
        } catch (rollbackError) {
          this.logger.error(
            JSON.stringify({
              event: 'saga.recovery.rollback_failed',
              error:
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError),
            }),
          );
        }
      }
      this.logger.error(
        JSON.stringify({
          event: 'saga.recovery.batch_failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      await runner.release();
    }
  }

  private async recoverStep(
    runner: import('typeorm').QueryRunner,
    step: OverdueStepRow,
  ): Promise<void> {
    const results = RESULT_TYPES[step.step_type];
    const placeholders = results.map(() => '?').join(', ');
    const [processedResult] = (await runner.query(
      `SELECT \`event_id\` FROM \`order_inbox_events\` WHERE \`aggregate_id\` = ? AND \`correlation_id\` = ? AND \`processing_status\` = 'PROCESSED' AND \`event_type\` IN (${placeholders}) LIMIT 1`,
      [step.order_id, step.correlation_id, ...results],
    )) as Array<{ event_id: string }>;
    if (processedResult) {
      await this.escalate(
        runner,
        step,
        'RESULT_PROCESSED_WITHOUT_STEP_COMPLETION',
        `Result ${processedResult.event_id} was processed but step ${step.step_type} remains active`,
      );
      return;
    }

    const commandId =
      step.step_type === SagaStepType.INVENTORY_RESERVATION
        ? step.correlation_id
        : step.command_id;
    if (!commandId) {
      await this.escalate(
        runner,
        step,
        'MISSING_STEP_COMMAND',
        `Overdue step ${step.step_type} has no command ID`,
      );
      return;
    }

    const [outbox] = (await runner.query(
      "SELECT `id`, `event_type`, `published_at`, `failed_at` FROM `outbox_events` WHERE `id` = ? OR JSON_UNQUOTE(JSON_EXTRACT(`payload`, '$.commandId')) = ? ORDER BY `created_at` DESC LIMIT 1 FOR UPDATE",
      [commandId, commandId],
    )) as OutboxStatusRow[];
    if (!outbox) {
      await this.escalate(
        runner,
        step,
        'MISSING_OUTBOX_COMMAND',
        `No outbox command exists for overdue step ${step.step_type}`,
      );
      return;
    }
    if (outbox.failed_at) {
      await this.escalate(
        runner,
        step,
        'OUTBOX_COMMAND_FAILED',
        `Outbox command ${outbox.id} exhausted publication retries`,
      );
      return;
    }
    if (!outbox.published_at) {
      await this.deferStep(runner, step.step_id);
      return;
    }

    if (step.step_type === SagaStepType.PAYMENT_AUTHORIZATION) {
      await this.reconcilePaymentTimeout(runner, step, outbox);
      return;
    }
    if (step.attempts >= MAX_TIMEOUT_RECOVERIES) {
      await this.escalate(
        runner,
        step,
        'STEP_TIMEOUT_RETRIES_EXHAUSTED',
        `Step ${step.step_type} timed out after ${step.attempts} attempts`,
      );
      return;
    }

    await runner.query(
      'UPDATE `outbox_events` SET `published_at` = NULL, `failed_at` = NULL, `attempts` = 0, `next_attempt_at` = UTC_TIMESTAMP(6), `last_error` = NULL WHERE `id` = ?',
      [outbox.id],
    );
    await runner.query(
      'UPDATE `saga_steps` SET `attempts` = `attempts` + 1, `deadline_at` = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? MICROSECOND) WHERE `id` = ?',
      [this.stepTimeoutMs(step.step_type) * 1000, step.step_id],
    );
    this.logger.warn(
      JSON.stringify({
        event: 'saga.recovery.command_republished',
        sagaId: step.saga_id,
        orderId: step.order_id,
        stepType: step.step_type,
        commandId,
        outboxEventId: outbox.id,
        attempt: step.attempts + 1,
        maxAttempts: MAX_TIMEOUT_RECOVERIES,
      }),
    );
  }

  private async reconcilePaymentTimeout(
    runner: import('typeorm').QueryRunner,
    step: OverdueStepRow,
    authorizationOutbox: OutboxStatusRow,
  ): Promise<void> {
    await runner.query(
      "UPDATE `order_sagas` SET `state` = 'MANUAL_INTERVENTION_REQUIRED', `failure_code` = 'PAYMENT_AUTHORIZATION_TIMEOUT', `failure_reason` = 'Payment authorization response timed out; payment status reconciliation is required', `completed_at` = NULL, `version` = `version` + 1 WHERE `id` = ?",
      [step.saga_id],
    );
    await this.recordOrderStatusTransition(
      runner,
      step.order_id,
      OrderStatus.REQUIRES_RECONCILIATION,
      'PAYMENT_AUTHORIZATION_TIMEOUT',
      'Payment authorization response timed out; reconciliation is required',
      step.correlation_id,
      step.command_id,
    );
    await runner.query(
      "UPDATE `saga_steps` SET `status` = 'MANUAL_INTERVENTION_REQUIRED', `last_error` = 'PAYMENT_AUTHORIZATION_TIMEOUT', `last_error_code` = 'PAYMENT_AUTHORIZATION_TIMEOUT', `deadline_at` = NULL, `completed_at` = UTC_TIMESTAMP(6) WHERE `id` = ?",
      [step.step_id],
    );

    const reconciliation = await runner.manager
      .getRepository(SagaStepEntity)
      .findOneByOrFail({
        sagaId: step.saga_id,
        stepType: SagaStepType.PAYMENT_RECONCILIATION,
      });
    if (reconciliation.status === SagaStepStatus.IN_PROGRESS) {
      await this.deferStep(runner, reconciliation.id);
    } else {
      const saga = await runner.manager
        .getRepository(OrderSagaEntity)
        .findOneByOrFail({ id: step.saga_id });
      await this.compensation.requestPaymentReconciliation(
        runner.manager,
        saga,
        authorizationOutbox.id,
      );
    }
    this.logger.error(
      JSON.stringify({
        event: 'saga.payment_authorization_timeout_reconciled',
        severity: 'critical',
        sagaId: step.saga_id,
        orderId: step.order_id,
        paymentOperationId: step.payment_operation_id,
        correlationId: step.correlation_id,
        causationId: authorizationOutbox.id,
      }),
    );
  }

  private async deferStep(
    runner: import('typeorm').QueryRunner,
    stepId: string,
    stepType?: SagaStepType,
  ): Promise<void> {
    const timeoutMs = stepType
      ? this.stepTimeoutMs(stepType)
      : this.timeouts.inventoryReservationMs;
    await runner.query(
      'UPDATE `saga_steps` SET `deadline_at` = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? MICROSECOND) WHERE `id` = ?',
      [timeoutMs * 1000, stepId],
    );
  }

  private async recordOrderStatusTransition(
    runner: QueryRunner,
    orderId: string,
    nextStatus: OrderStatus,
    reasonCode: string,
    reason: string,
    correlationId: string | null,
    causationId: string | null,
  ): Promise<void> {
    const rows = (await runner.query(
      'SELECT `status` FROM `orders` WHERE `id` = ? FOR UPDATE',
      [orderId],
    )) as OrderStatusRow[];
    const order = rows[0];
    if (!order) throw new Error(`Order ${orderId} does not exist`);
    if (order.status === OrderStatus.CANCELLED || order.status === nextStatus) {
      return;
    }

    const sequenceRows = (await runner.query(
      'SELECT COALESCE(MAX(`sequence_number`), 0) + 1 AS `next_sequence` FROM `order_status_history` WHERE `order_id` = ?',
      [orderId],
    )) as Array<{ next_sequence: number | string }>;
    const sequenceNumber = Number(sequenceRows[0]?.next_sequence);
    if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1) {
      throw new Error(`Could not allocate order ${orderId} history sequence`);
    }

    await runner.query(
      'INSERT INTO `order_status_history` (`id`, `order_id`, `sequence_number`, `from_status`, `to_status`, `reason_code`, `reason`, `correlation_id`, `causation_id`, `occurred_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
      [
        randomUUID(),
        orderId,
        sequenceNumber,
        order.status,
        nextStatus,
        reasonCode.slice(0, 100),
        reason.slice(0, 255),
        correlationId,
        causationId,
      ],
    );
    await runner.query(
      'UPDATE `orders` SET `status` = ?, `updated_at` = UTC_TIMESTAMP(6) WHERE `id` = ?',
      [nextStatus, orderId],
    );
  }

  private stepTimeoutMs(stepType: SagaStepType): number {
    switch (stepType) {
      case SagaStepType.INVENTORY_RESERVATION:
        return this.timeouts.inventoryReservationMs;
      case SagaStepType.PAYMENT_AUTHORIZATION:
        return this.timeouts.paymentAuthorizationMs;
      case SagaStepType.PAYMENT_RECONCILIATION:
        return this.timeouts.paymentCaptureMs;
      case SagaStepType.PAYMENT_VOID:
        return this.timeouts.paymentVoidMs;
      case SagaStepType.PAYMENT_REFUND:
        return this.timeouts.paymentRefundMs;
      case SagaStepType.INVENTORY_RELEASE:
        return this.timeouts.inventoryReleaseMs;
    }
  }

  private async escalate(
    runner: import('typeorm').QueryRunner,
    step: OverdueStepRow,
    code: string,
    reason: string,
  ): Promise<void> {
    await runner.query(
      "UPDATE `order_sagas` SET `state` = 'MANUAL_INTERVENTION_REQUIRED', `failure_code` = ?, `failure_reason` = ?, `completed_at` = NULL, `version` = `version` + 1 WHERE `id` = ? AND `state` <> 'MANUAL_INTERVENTION_REQUIRED'",
      [code, reason.slice(0, 1000), step.saga_id],
    );
    await this.recordOrderStatusTransition(
      runner,
      step.order_id,
      OrderStatus.REQUIRES_RECONCILIATION,
      code,
      reason,
      step.correlation_id,
      step.command_id,
    );
    await runner.query(
      "UPDATE `saga_steps` SET `status` = 'MANUAL_INTERVENTION_REQUIRED', `last_error` = ?, `last_error_code` = ?, `deadline_at` = NULL, `completed_at` = UTC_TIMESTAMP(6) WHERE `id` = ?",
      [code, step.step_id],
    );
    this.logger.error(
      JSON.stringify({
        event: 'saga.recovery.escalated',
        severity: 'critical',
        sagaId: step.saga_id,
        orderId: step.order_id,
        stepType: step.step_type,
        correlationId: step.correlation_id,
        causationId: step.command_id,
        failureCode: code,
        failureReason: reason,
      }),
    );
  }

  private startMetricsServer(): void {
    const server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url?.startsWith('/sagas/')) {
        await this.handleSagaInspection(request, response);
        return;
      }
      if (request.method === 'POST' && request.url?.startsWith('/sagas/')) {
        await this.handleReconciliationRequest(request, response);
        return;
      }
      if (request.method !== 'GET' || request.url !== '/metrics') {
        response.writeHead(404);
        response.end('Not Found');
        return;
      }

      void this.getMetrics()
        .then((metrics) => {
          response.writeHead(200, {
            'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          });
          response.end(
            [
              '# HELP saga_active_workflows Number of non-terminal Saga workflows.',
              '# TYPE saga_active_workflows gauge',
              `saga_active_workflows ${metrics.activeSagas}`,
              '# HELP saga_failed_workflows Number of failed or manually escalated Sagas.',
              '# TYPE saga_failed_workflows gauge',
              `saga_failed_workflows ${metrics.failedSagas}`,
              '# HELP saga_overdue_steps Number of steps past their persisted deadline.',
              '# TYPE saga_overdue_steps gauge',
              `saga_overdue_steps ${metrics.overdueSteps}`,
              '# HELP saga_compensation_success_total Successfully compensated steps.',
              '# TYPE saga_compensation_success_total counter',
              `saga_compensation_success_total ${metrics.compensationSucceeded}`,
              '# HELP saga_compensation_failure_total Compensation steps requiring intervention.',
              '# TYPE saga_compensation_failure_total counter',
              `saga_compensation_failure_total ${metrics.compensationFailed}`,
              '# HELP saga_execution_duration_seconds_average Average completed Saga duration.',
              '# TYPE saga_execution_duration_seconds_average gauge',
              `saga_execution_duration_seconds_average ${metrics.averageExecutionDurationSeconds}`,
              '# HELP order_confirmation_waiting Number of orders awaiting payment authorization.',
              '# TYPE order_confirmation_waiting gauge',
              `order_confirmation_waiting ${metrics.ordersWaitingForConfirmation}`,
              '# HELP order_confirmation_results_without_event Number with successful inventory/payment steps but no confirmation event.',
              '# TYPE order_confirmation_results_without_event gauge',
              `order_confirmation_results_without_event ${metrics.successfulResultsAwaitingConfirmation}`,
              '# HELP order_confirmation_outbox_pending Number of pending confirmation Outbox events.',
              '# TYPE order_confirmation_outbox_pending gauge',
              `order_confirmation_outbox_pending ${metrics.pendingConfirmationEvents}`,
              '# HELP order_confirmation_outbox_failed Number of failed confirmation Outbox events.',
              '# TYPE order_confirmation_outbox_failed gauge',
              `order_confirmation_outbox_failed ${metrics.failedConfirmationEvents}`,
              '# HELP order_confirmation_attempts_total Number of payment-result confirmation attempts handled by this process.',
              '# TYPE order_confirmation_attempts_total counter',
              `order_confirmation_attempts_total ${metrics.confirmationAttempts}`,
              '# HELP order_confirmation_success_total Number of successfully committed confirmations.',
              '# TYPE order_confirmation_success_total counter',
              `order_confirmation_success_total ${metrics.confirmationSuccesses}`,
              '# HELP order_confirmation_failure_total Number of failed confirmation transactions.',
              '# TYPE order_confirmation_failure_total counter',
              `order_confirmation_failure_total ${metrics.confirmationFailures}`,
              '# HELP order_confirmation_duplicate_total Number of duplicate payment confirmation attempts.',
              '# TYPE order_confirmation_duplicate_total counter',
              `order_confirmation_duplicate_total ${metrics.duplicateConfirmationAttempts}`,
              '# HELP order_confirmation_transaction_duration_ms_total Total duration of confirmation transaction attempts.',
              '# TYPE order_confirmation_transaction_duration_ms_total counter',
              `order_confirmation_transaction_duration_ms_total ${metrics.confirmationDurationTotalMs}`,
              '# HELP order_confirmation_transaction_duration_count Number of confirmation transaction durations recorded.',
              '# TYPE order_confirmation_transaction_duration_count counter',
              `order_confirmation_transaction_duration_count ${metrics.confirmationDurationCount}`,
              '# HELP saga_compensation_initiations_total Compensation workflows persisted.',
              '# TYPE saga_compensation_initiations_total counter',
              `saga_compensation_initiations_total ${metrics.compensationInitiations}`,
              '# HELP saga_compensation_pending_steps Compensation steps awaiting an outcome.',
              '# TYPE saga_compensation_pending_steps gauge',
              `saga_compensation_pending_steps ${metrics.compensationPendingSteps}`,
              '# HELP saga_compensation_retry_attempts Number of compensation attempts beyond the first.',
              '# TYPE saga_compensation_retry_attempts gauge',
              `saga_compensation_retry_attempts ${metrics.compensationRetryAttempts}`,
              '# HELP saga_compensation_oldest_age_seconds Age of the oldest unresolved compensation.',
              '# TYPE saga_compensation_oldest_age_seconds gauge',
              `saga_compensation_oldest_age_seconds ${metrics.compensationOldestAgeSeconds}`,
              '# HELP saga_compensation_manual_interventions Number of compensations requiring human intervention.',
              '# TYPE saga_compensation_manual_interventions gauge',
              `saga_compensation_manual_interventions ${metrics.compensationManualInterventions}`,
              '# HELP saga_compensation_step_duration_seconds Average duration of completed compensation steps.',
              '# TYPE saga_compensation_step_duration_seconds gauge',
              ...Object.entries(metrics.compensationStepDurationSeconds).map(
                ([stepType, duration]) =>
                  `saga_compensation_step_duration_seconds{step_type="${stepType}"} ${duration}`,
              ),
              this.orderQueryMetrics.renderPrometheus().trimEnd(),
              '',
            ].join('\n'),
          );
        })
        .catch((error: unknown) => {
          this.logger.error(
            JSON.stringify({
              event: 'saga.metrics.query_failed',
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          if (!response.headersSent) response.writeHead(503);
          response.end('Saga metrics temporarily unavailable');
        });
    });
    server.on('error', (error) => {
      this.logger.error(
        JSON.stringify({
          event: 'saga.metrics.server_failed',
          host: this.metricsHost,
          port: this.metricsPort,
          error: error.message,
        }),
      );
    });
    server.listen(this.metricsPort, this.metricsHost, () => {
      this.metricsServer = server;
      this.logger.log(
        JSON.stringify({
          event: 'saga.metrics.server_started',
          host: this.metricsHost,
          port: this.metricsPort,
        }),
      );
    });
  }

  private async handleSagaInspection(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    if (!this.authorizeOperationsRequest(request)) {
      response.writeHead(401);
      response.end('Unauthorized');
      return;
    }
    const orderId = this.orderIdFromPath(request.url, null);
    if (!orderId) {
      response.writeHead(400);
      response.end('Invalid order ID');
      return;
    }
    try {
      const saga = await this.getSagaByOrderId(orderId);
      if (!saga) {
        response.writeHead(404);
        response.end('Saga not found');
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(
        JSON.stringify({
          id: saga.id,
          orderId: saga.orderId,
          state: saga.currentState,
          correlationId: saga.correlationId,
          inventoryReservationId: saga.inventoryReservationId,
          paymentOperationId: saga.paymentOperationId,
          paymentAuthorizationId: saga.paymentAuthorizationId,
          failureCode: saga.failureCode,
          failureReason: saga.failureReason,
          compensationReason: saga.compensationReason,
          compensationStatus: saga.compensationStatus,
          compensationStartedAt: saga.compensationStartedAt,
          compensationCompletedAt: saga.compensationCompletedAt,
          compensationFailureReason: saga.compensationFailureReason,
          startedAt: saga.startedAt,
          completedAt: saga.completedAt,
          updatedAt: saga.updatedAt,
          steps: saga.steps.map((step) => ({
            stepType: step.stepType,
            status: step.status,
            commandId: step.commandId,
            operationId: step.operationId,
            attempts: step.attemptCount,
            lastError: step.lastError,
            nextRetryAt: step.nextRetryAt,
            startedAt: step.startedAt,
            deadlineAt: step.deadlineAt,
            completedAt: step.completedAt,
          })),
        }),
      );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'saga.operations.inspect_failed',
          orderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      response.writeHead(503);
      response.end('Saga inspection unavailable');
    }
  }

  private async handleReconciliationRequest(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    if (!this.authorizeOperationsRequest(request)) {
      response.writeHead(401);
      response.end('Unauthorized');
      return;
    }
    const orderId = this.orderIdFromPath(request.url, '/reconcile-payment');
    if (!orderId) {
      response.writeHead(400);
      response.end('Invalid order ID');
      return;
    }
    try {
      await this.requestPaymentReconciliation(orderId);
      response.writeHead(202, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({ accepted: true, orderId }));
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'saga.operations.reconciliation_request_failed',
          orderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      response.writeHead(409);
      response.end('Payment reconciliation request could not be accepted');
    }
  }

  private orderIdFromPath(
    requestUrl: string | undefined,
    suffix: string | null = '',
  ): string | null {
    if (!requestUrl) return null;
    const path = requestUrl.split('?')[0];
    const match = /^\/sagas\/([0-9a-f-]{36})(?:\/reconcile-payment)?$/i.exec(
      path,
    );
    if (
      !match ||
      (suffix !== null && suffix !== '' && !path.endsWith(suffix)) ||
      (suffix === null && path.endsWith('/reconcile-payment'))
    ) {
      return null;
    }
    return match[1];
  }

  private authorizeOperationsRequest(
    request: import('node:http').IncomingMessage,
  ): boolean {
    const token = this.config.get<string>('SAGA_OPERATIONS_TOKEN');
    const authorization = request.headers.authorization;
    if (!token || !authorization?.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(authorization.slice('Bearer '.length));
    const expected = Buffer.from(token);
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  }

  private async stopMetricsServer(): Promise<void> {
    const server = this.metricsServer;
    this.metricsServer = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private readPositiveInteger(name: string, defaultValue: number): number {
    const value = this.config.get<string>(name);
    if (value === undefined) return defaultValue;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
  }
}
