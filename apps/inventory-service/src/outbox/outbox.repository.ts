import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';

import type { InventoryEvent } from 'default/contracts';
import { OutboxEventEntity } from './entities/outbox-event.entity';

export interface ClaimedInventoryOutboxEvent {
  id: string;
  eventType: string;
  payload: InventoryEvent;
  attempts: number;
}

@Injectable()
export class OutboxRepository {
  constructor(private readonly dataSource: DataSource) {}

  async claimBatch(
    batchSize: number,
    leaseDurationMs: number,
  ): Promise<{ claimToken: string; events: ClaimedInventoryOutboxEvent[] }> {
    const claimToken = randomUUID();
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.startTransaction();
      const rows = (await queryRunner.query(
        'SELECT `id` FROM `outbox_events` WHERE `published_at` IS NULL AND `failed_at` IS NULL AND `next_attempt_at` <= UTC_TIMESTAMP(6) AND (`locked_until` IS NULL OR `locked_until` <= UTC_TIMESTAMP(6)) ORDER BY `created_at`, `id` LIMIT ? FOR UPDATE SKIP LOCKED',
        [batchSize],
      )) as Array<{ id: string }>;

      if (rows.length === 0) {
        await queryRunner.commitTransaction();
        return { claimToken, events: [] };
      }

      const ids = rows.map(({ id }) => id);
      const placeholders = ids.map(() => '?').join(', ');
      const leaseMicroseconds = Math.trunc(leaseDurationMs * 1000);
      await queryRunner.query(
        `UPDATE \`outbox_events\` SET \`locked_by\` = ?, \`locked_until\` = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${leaseMicroseconds} MICROSECOND) WHERE \`id\` IN (${placeholders})`,
        [claimToken, ...ids],
      );
      const claimedRows = (await queryRunner.query(
        'SELECT `id`, `event_type`, `payload`, `attempts` FROM `outbox_events` WHERE `locked_by` = ? AND `published_at` IS NULL AND `failed_at` IS NULL ORDER BY `created_at`, `id`',
        [claimToken],
      )) as Array<{
        id: string;
        event_type: string;
        payload: Record<string, unknown> | string;
        attempts: number;
      }>;
      await queryRunner.commitTransaction();

      return {
        claimToken,
        events: claimedRows.map((row) => ({
          id: row.id,
          eventType: row.event_type,
          payload: (typeof row.payload === 'string'
            ? JSON.parse(row.payload)
            : row.payload) as InventoryEvent,
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
    const result = await this.dataSource.query(
      'UPDATE `outbox_events` SET `published_at` = UTC_TIMESTAMP(6), `locked_by` = NULL, `locked_until` = NULL, `last_error` = NULL WHERE `id` = ? AND `locked_by` = ? AND `published_at` IS NULL AND `failed_at` IS NULL AND `locked_until` > UTC_TIMESTAMP(6)',
      [eventId, claimToken],
    );
    return result.affectedRows === 1;
  }

  async scheduleRetry(
    eventId: string,
    claimToken: string,
    retryDelayMs: number,
    errorMessage: string,
    attempts: number,
    maxAttempts: number,
  ): Promise<'scheduled' | 'exhausted' | 'not-owned'> {
    const retryMicroseconds = Math.trunc(retryDelayMs * 1000);
    const exhausted = attempts + 1 >= maxAttempts;
    const result = await this.dataSource.query(
      `UPDATE \`outbox_events\` SET \`attempts\` = \`attempts\` + 1, \`next_attempt_at\` = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${retryMicroseconds} MICROSECOND), \`failed_at\` = ${exhausted ? 'UTC_TIMESTAMP(6)' : 'NULL'}, \`last_error\` = ?, \`locked_by\` = NULL, \`locked_until\` = NULL WHERE \`id\` = ? AND \`locked_by\` = ? AND \`published_at\` IS NULL AND \`failed_at\` IS NULL AND \`locked_until\` > UTC_TIMESTAMP(6)`,
      [errorMessage.slice(0, 1000), eventId, claimToken],
    );
    if (result.affectedRows !== 1) {
      return 'not-owned';
    }
    return exhausted ? 'exhausted' : 'scheduled';
  }

  async getMetrics(stuckReservationAgeSeconds = 3600): Promise<{
    pendingEvents: number;
    failedEvents: number;
    publishFailuresTotal: number;
    oldestPendingAgeSeconds: number;
    reservationsSucceededTotal: number;
    reservationsFailedTotal: number;
    stuckReservations: number;
    oldestReservedAgeSeconds: number;
  }> {
    const [row] = (await this.dataSource.query(
      'SELECT COALESCE(SUM(CASE WHEN `published_at` IS NULL AND `failed_at` IS NULL THEN 1 ELSE 0 END), 0) AS `pending_events`, COALESCE(SUM(CASE WHEN `failed_at` IS NOT NULL THEN 1 ELSE 0 END), 0) AS `failed_events`, COALESCE(SUM(`attempts`), 0) AS `publish_failures_total`, COALESCE(TIMESTAMPDIFF(MICROSECOND, MIN(CASE WHEN `published_at` IS NULL AND `failed_at` IS NULL THEN `created_at` END), UTC_TIMESTAMP(6)) / 1000000, 0) AS `oldest_pending_age_seconds`, (SELECT COUNT(*) FROM `outbox_events` WHERE `event_type` = ?) AS `reservations_succeeded_total`, (SELECT COUNT(*) FROM `outbox_events` WHERE `event_type` = ?) AS `reservations_failed_total`, (SELECT COUNT(*) FROM `inventory_reservations` WHERE `status` = ? AND `created_at` <= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? SECOND)) AS `stuck_reservations`, COALESCE((SELECT TIMESTAMPDIFF(MICROSECOND, MIN(`created_at`), UTC_TIMESTAMP(6)) / 1000000 FROM `inventory_reservations` WHERE `status` = ?), 0) AS `oldest_reserved_age_seconds` FROM `outbox_events`',
      [
        'inventory.reserved.v1',
        'inventory.reservation_failed.v1',
        'RESERVED',
        stuckReservationAgeSeconds,
        'RESERVED',
      ],
    )) as Array<{
      pending_events: number | string;
      failed_events: number | string;
      publish_failures_total: number | string;
      oldest_pending_age_seconds: number | string;
      reservations_succeeded_total: number | string;
      reservations_failed_total: number | string;
      stuck_reservations: number | string;
      oldest_reserved_age_seconds: number | string;
    }>;
    return {
      pendingEvents: Number(row.pending_events),
      failedEvents: Number(row.failed_events),
      publishFailuresTotal: Number(row.publish_failures_total),
      oldestPendingAgeSeconds: Number(row.oldest_pending_age_seconds),
      reservationsSucceededTotal: Number(row.reservations_succeeded_total),
      reservationsFailedTotal: Number(row.reservations_failed_total),
      stuckReservations: Number(row.stuck_reservations),
      oldestReservedAgeSeconds: Number(row.oldest_reserved_age_seconds),
    };
  }

  private async rollback(
    queryRunner: QueryRunner,
    originalError: unknown,
  ): Promise<void> {
    try {
      await queryRunner.rollbackTransaction();
    } catch (rollbackError) {
      throw new AggregateError(
        [originalError, rollbackError],
        'Inventory outbox claim failed and its transaction could not be rolled back',
      );
    }
  }
}
