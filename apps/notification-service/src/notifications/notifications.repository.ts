import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { NotificationEntity } from './entities/notification.entity';
import { NotificationStatus } from './notification-status.enum';

export interface ClaimedNotificationBatch {
  claimToken: string;
  notifications: NotificationEntity[];
}

@Injectable()
export class NotificationsRepository {
  constructor(private readonly dataSource: DataSource) {}

  async claimPendingBatch(
    batchSize: number,
    leaseMs: number,
  ): Promise<ClaimedNotificationBatch> {
    const claimToken = randomUUID();
    const notifications = await this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        'SELECT `id` FROM `notifications` WHERE `status` IN (?, ?) AND (`next_retry_at` IS NULL OR `next_retry_at` <= NOW(6)) ORDER BY `created_at` LIMIT ? FOR UPDATE SKIP LOCKED',
        [NotificationStatus.PENDING, NotificationStatus.SENDING, batchSize],
      )) as Array<{ id: string }>;
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const leaseUntil = new Date(Date.now() + leaseMs);
      for (const id of ids) {
        await manager.update(
          NotificationEntity,
          { id },
          { status: NotificationStatus.SENDING, nextRetryAt: leaseUntil },
        );
      }
      return manager.getRepository(NotificationEntity).findBy(ids);
    });
    return { claimToken, notifications };
  }

  async markSent(
    id: string,
    providerMessageId: string | null,
  ): Promise<void> {
    await this.dataSource.getRepository(NotificationEntity).update(
      { id },
      {
        status: NotificationStatus.SENT,
        sentAt: new Date(),
        providerMessageId,
        lastError: null,
        nextRetryAt: null,
      },
    );
  }

  async scheduleRetry(
    id: string,
    delayMs: number,
    error: string,
    maxAttempts: number,
  ): Promise<'scheduled' | 'exhausted'> {
    const repo = this.dataSource.getRepository(NotificationEntity);
    const notification = await repo.findOneBy({ id });
    if (!notification) return 'exhausted';
    const retryCount = notification.retryCount + 1;
    const exhausted = retryCount >= maxAttempts;
    await repo.update(
      { id },
      {
        retryCount,
        status: exhausted ? NotificationStatus.FAILED : NotificationStatus.PENDING,
        nextRetryAt: exhausted ? null : new Date(Date.now() + delayMs),
        lastError: error.slice(0, 1000),
      },
    );
    return exhausted ? 'exhausted' : 'scheduled';
  }

  async findStaleNotifications(
    olderThanMs: number,
    limit: number,
  ): Promise<NotificationEntity[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    return this.dataSource
      .getRepository(NotificationEntity)
      .createQueryBuilder('n')
      .where('n.status = :status', { status: NotificationStatus.SENDING })
      .andWhere('n.nextRetryAt < :cutoff', { cutoff })
      .orderBy('n.nextRetryAt', 'ASC')
      .take(limit)
      .getMany();
  }

    async markFailed(
    id: string,
    error: string,
    status: NotificationStatus,
  ): Promise<void> {
    await this.dataSource.getRepository(NotificationEntity).update(
      { id },
      {
        status,
        lastError: error.slice(0, 1000),
        nextRetryAt: null,
      },
    );
  }

}
