import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { OutboxEventEntity } from './entities/outbox-event.entity';

export interface ClaimedPaymentOutboxBatch {
  claimToken: string;
  events: OutboxEventEntity[];
}

@Injectable()
export class OutboxRepository {
  constructor(private readonly dataSource: DataSource) {}

  async claimBatch(
    batchSize: number,
    leaseMs: number,
  ): Promise<ClaimedPaymentOutboxBatch> {
    const claimToken = randomUUID();
    const events = await this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        'SELECT `id` FROM `payment_outbox_events` WHERE `status` = ? AND `next_retry_at` <= NOW(6) AND (`locked_until` IS NULL OR `locked_until` <= NOW(6)) ORDER BY `created_at` LIMIT ? FOR UPDATE SKIP LOCKED',
        ['PENDING', batchSize],
      )) as Array<{ id: string }>;
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      const lockedUntil = new Date(Date.now() + leaseMs);
      for (const id of ids) {
        await manager.update(
          OutboxEventEntity,
          { id, status: 'PENDING' },
          { claimToken, lockedUntil },
        );
      }
      return manager.getRepository(OutboxEventEntity).find({
        where: ids.map((id) => ({ id, claimToken })),
        order: { createdAt: 'ASC' },
      });
    });
    return { claimToken, events };
  }

  async markPublished(id: string, claimToken: string): Promise<boolean> {
    const result = await this.dataSource
      .getRepository(OutboxEventEntity)
      .update(
        { id, claimToken, status: 'PENDING' },
        {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          failedAt: null,
          lockedUntil: null,
          claimToken: null,
          lastError: null,
        },
      );
    return result.affected === 1;
  }

  async scheduleRetry(
    id: string,
    claimToken: string,
    delayMs: number,
    error: string,
    maxAttempts: number,
  ): Promise<'scheduled' | 'exhausted' | 'not-owned'> {
    const event = await this.dataSource
      .getRepository(OutboxEventEntity)
      .findOne({
        where: { id, claimToken, status: 'PENDING' },
      });
    if (!event) return 'not-owned';
    const retryCount = event.retryCount + 1;
    const exhausted = retryCount >= maxAttempts;
    const updated = await this.dataSource.getRepository(OutboxEventEntity).update(
      { id, claimToken, status: 'PENDING' },
      {
        retryCount,
        nextRetryAt: new Date(Date.now() + delayMs),
        lastError: error.slice(0, 1000),
        status: exhausted ? 'FAILED' : 'PENDING',
        failedAt: exhausted ? new Date() : null,
        lockedUntil: null,
        claimToken: null,
      },
    );
    if (updated.affected !== 1) return 'not-owned';
    return exhausted ? 'exhausted' : 'scheduled';
  }
}
