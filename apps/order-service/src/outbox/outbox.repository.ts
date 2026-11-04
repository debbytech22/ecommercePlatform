import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { OrderEntity, OrderStatus } from '../entities/order.entity';
import { OrderStatusHistoryService } from '../orders/order-status-history.service';

import type { OutboxEvent } from './outbox-event.types';

interface ClaimedOutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  attempts: number;
}

export interface OutboxMetrics {
  pendingEvents: number;
  failedEvents: number;
  publishFailuresTotal: number;
  oldestPendingAgeSeconds: number;
}

export type RetryScheduleResult = 'scheduled' | 'exhausted' | 'not-owned';

@Injectable()
export class OutboxRepository {
  constructor(private readonly dataSource: DataSource) {}

  async claimBatch(
    batchSize: number,
    leaseDurationMs: number,
  ): Promise<{ claimToken: string; events: OutboxEvent[] }> {
    const claimToken = randomUUID();
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.startTransaction();
      const available = (await queryRunner.query(
        'SELECT `id` FROM `outbox_events` WHERE `published_at` IS NULL AND `failed_at` IS NULL AND `next_attempt_at` <= UTC_TIMESTAMP(6) AND (`locked_until` IS NULL OR `locked_until` <= UTC_TIMESTAMP(6)) ORDER BY `created_at`, `id` LIMIT ? FOR UPDATE SKIP LOCKED',
        [batchSize],
      )) as Array<{ id: string }>;

      if (available.length === 0) {
        await queryRunner.commitTransaction();
        return { claimToken, events: [] };
      }

      const ids = available.map(({ id }) => id);
      const placeholders = ids.map(() => '?').join(', ');
      const leaseMicroseconds = Math.trunc(leaseDurationMs * 1000);
      await queryRunner.query(
        `UPDATE \`outbox_events\` SET \`locked_by\` = ?, \`locked_until\` = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${leaseMicroseconds} MICROSECOND) WHERE \`id\` IN (${placeholders})`,
        [claimToken, ...ids],
      );

      const rows = (await queryRunner.query(
        `SELECT \`id\`, \`aggregate_type\`, \`aggregate_id\`, \`event_type\`, \`payload\`, \`attempts\` FROM \`outbox_events\` WHERE \`locked_by\` = ? AND \`published_at\` IS NULL AND \`failed_at\` IS NULL ORDER BY \`created_at\`, \`id\``,
        [claimToken],
      )) as ClaimedOutboxRow[];

      await queryRunner.commitTransaction();
      return {
        claimToken,
        events: rows.map((row) => ({
          id: row.id,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload:
            typeof row.payload === 'string'
              ? (JSON.parse(row.payload) as Record<string, unknown>)
              : row.payload,
          attempts: row.attempts,
        })),
      };
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await this.rollback(queryRunner, error);
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async markPublished(eventId: string, claimToken: string): Promise<boolean> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.startTransaction();
      const [event] = (await queryRunner.query(
        'SELECT `event_type`, `aggregate_id` FROM `outbox_events` WHERE `id` = ? AND `locked_by` = ? AND `published_at` IS NULL AND `failed_at` IS NULL AND `locked_until` > UTC_TIMESTAMP(6) FOR UPDATE',
        [eventId, claimToken],
      )) as Array<{ event_type: string; aggregate_id: string }>;
      if (!event) {
        await queryRunner.commitTransaction();
        return false;
      }

      const result = await queryRunner.query(
        'UPDATE `outbox_events` SET `published_at` = UTC_TIMESTAMP(6), `locked_by` = NULL, `locked_until` = NULL, `last_error` = NULL WHERE `id` = ? AND `locked_by` = ? AND `published_at` IS NULL AND `failed_at` IS NULL AND `locked_until` > UTC_TIMESTAMP(6)',
        [eventId, claimToken],
      );
      if (result.affectedRows !== 1) {
        await queryRunner.commitTransaction();
        return false;
      }

      await queryRunner.commitTransaction();
      return true;
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Failed to commit the published outbox event and roll back its database transaction',
          );
        }
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async scheduleRetry(
    eventId: string,
    claimToken: string,
    retryDelayMs: number,
    errorMessage: string,
    currentAttempts: number,
    maxAttempts: number,
  ): Promise<RetryScheduleResult> {
    const retryMicroseconds = Math.trunc(retryDelayMs * 1000);
    const exhausted = currentAttempts + 1 >= maxAttempts;
    const result = await this.dataSource.transaction(async (manager) => {
      const update = await manager.query(
        `UPDATE \`outbox_events\` SET \`attempts\` = \`attempts\` + 1, \`next_attempt_at\` = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${retryMicroseconds} MICROSECOND), \`failed_at\` = ${exhausted ? 'UTC_TIMESTAMP(6)' : 'NULL'}, \`last_error\` = ?, \`locked_by\` = NULL, \`locked_until\` = NULL WHERE \`id\` = ? AND \`locked_by\` = ? AND \`published_at\` IS NULL AND \`failed_at\` IS NULL AND \`locked_until\` > UTC_TIMESTAMP(6)`,
        [errorMessage.slice(0, 1000), eventId, claimToken],
      );
      if (update.affectedRows !== 1 || !exhausted) {
        return update;
      }

      const [event] = (await manager.query(
        'SELECT `aggregate_id`, `event_type`, `payload` FROM `outbox_events` WHERE `id` = ?',
        [eventId],
      )) as Array<{
        aggregate_id: string;
        event_type: string;
        payload: Record<string, unknown> | string;
      }>;
      if (!event) return update;
      if (event.event_type === 'order.confirmed.v1') return update;

      const payload =
        typeof event.payload === 'string'
          ? (JSON.parse(event.payload) as Record<string, unknown>)
          : event.payload;
      const reason =
        `Outbox publication exhausted after ${maxAttempts} attempts: ${errorMessage}`.slice(
          0,
          1000,
        );
      const [saga] = (await manager.query(
        'SELECT `id` FROM `order_sagas` WHERE `order_id` = ?',
        [event.aggregate_id],
      )) as Array<{ id: string }>;
      if (!saga) return update;

      await manager.query(
        "UPDATE `order_sagas` SET `state` = 'MANUAL_INTERVENTION_REQUIRED', `failure_code` = 'OUTBOX_RETRIES_EXHAUSTED', `failure_reason` = ?, `completed_at` = NULL, `version` = `version` + 1 WHERE `id` = ? AND `state` <> 'MANUAL_INTERVENTION_REQUIRED'",
        [reason, saga.id],
      );
      const order = await manager.getRepository(OrderEntity).findOne({
        where: { id: event.aggregate_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new Error('Outbox aggregate order does not exist');
      if (order.status !== OrderStatus.CANCELLED) {
        await OrderStatusHistoryService.transition(
          manager,
          order,
          OrderStatus.REQUIRES_RECONCILIATION,
          {
            reasonCode: 'OUTBOX_RETRIES_EXHAUSTED',
            reason:
              'Order processing requires review after event delivery failed',
            correlationId:
              typeof payload.correlationId === 'string'
                ? payload.correlationId
                : null,
            causationId:
              typeof payload.causationId === 'string'
                ? payload.causationId
                : typeof payload.commandId === 'string'
                  ? payload.commandId
                  : null,
          },
        );
      }

      const commandId = payload.commandId;
      if (typeof commandId === 'string') {
        await manager.query(
          "UPDATE `saga_steps` SET `status` = 'MANUAL_INTERVENTION_REQUIRED', `last_error` = ?, `completed_at` = UTC_TIMESTAMP(6) WHERE `saga_id` = ? AND `command_id` = ?",
          [reason, saga.id, commandId],
        );
      }
      return update;
    });
    if (result.affectedRows !== 1) {
      return 'not-owned';
    }
    return exhausted ? 'exhausted' : 'scheduled';
  }

  async getMetrics(): Promise<OutboxMetrics> {
    const [row] = (await this.dataSource.query(
      'SELECT COALESCE(SUM(CASE WHEN `published_at` IS NULL AND `failed_at` IS NULL THEN 1 ELSE 0 END), 0) AS `pending_events`, COALESCE(SUM(CASE WHEN `failed_at` IS NOT NULL THEN 1 ELSE 0 END), 0) AS `failed_events`, COALESCE(SUM(`attempts`), 0) AS `publish_failures_total`, COALESCE(TIMESTAMPDIFF(MICROSECOND, MIN(CASE WHEN `published_at` IS NULL AND `failed_at` IS NULL THEN `created_at` END), UTC_TIMESTAMP(6)) / 1000000, 0) AS `oldest_pending_age_seconds` FROM `outbox_events`',
    )) as Array<{
      pending_events: number | string;
      failed_events: number | string;
      publish_failures_total: number | string;
      oldest_pending_age_seconds: number | string;
    }>;

    return {
      pendingEvents: Number(row.pending_events),
      failedEvents: Number(row.failed_events),
      publishFailuresTotal: Number(row.publish_failures_total),
      oldestPendingAgeSeconds: Number(row.oldest_pending_age_seconds),
    };
  }

  private async rollback(
    queryRunner: QueryRunner,
    originalError: unknown,
  ): Promise<void> {
    try {
      await queryRunner.rollbackTransaction();
    } catch (rollbackError) {
      const originalMessage =
        originalError instanceof Error
          ? originalError.message
          : String(originalError);
      const rollbackMessage =
        rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
      throw new AggregateError(
        [originalError, rollbackError],
        `Outbox claim failed (${originalMessage}) and rollback failed (${rollbackMessage})`,
      );
    }
  }
}
