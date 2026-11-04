import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InboxEventEntity, InboxEventStatus } from '../inbox/entities/inbox-event.entity';
import { NotificationAttemptEntity } from './entities/notification-attempt.entity';
import { NotificationEntity } from './entities/notification.entity';
import { NotificationPreferenceEntity } from './entities/notification-preference.entity';
import {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
} from './notification-status.enum';

export interface CreateNotificationCommand {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  recipientId: string;
  recipientAddress: string;
  orderId: string | null;
  channel: NotificationChannel;
  type: NotificationType;
  templateKey: string;
  subject: string;
  body: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly dataSource: DataSource) {}

  async createFromEvent(command: CreateNotificationCommand): Promise<'created' | 'duplicate'> {
    return this.dataSource.transaction(async (manager) => {
      const inboxRepo = manager.getRepository(InboxEventEntity);
      const existing = await inboxRepo.findOne({
        where: { eventId: command.eventId },
        lock: { mode: 'pessimistic_write' },
      });

      if (existing) {
        if (existing.status === InboxEventStatus.PROCESSED) return 'duplicate';
        if (existing.status === InboxEventStatus.FAILED) {
          throw new ConflictException('Event previously failed processing');
        }
        // PROCESSING — prior in-flight attempt; continue idempotently
      } else {
        await inboxRepo.save(
          inboxRepo.create({
            id: randomUUID(),
            eventId: command.eventId,
            eventType: command.eventType,
            aggregateId: command.aggregateId,
            correlationId: command.correlationId,
            status: InboxEventStatus.PROCESSING,
            processedAt: null,
            errorMessage: null,
          }),
        );
      }

      const enabled = await this.isChannelEnabled(
        manager,
        command.recipientId,
        command.type,
        command.channel,
      );
      if (!enabled) {
        await this.markInboxProcessed(manager, command.eventId);
        this.logger.log(
          JSON.stringify({
            event: 'notification.suppressed_by_preference',
            recipientId: command.recipientId,
            type: command.type,
            channel: command.channel,
            correlationId: command.correlationId,
          }),
        );
        return 'duplicate';
      }

      // One notification per (eventId, recipientAddress, channel)
      const idempotencyKey = `${command.eventId}:${command.recipientAddress}:${command.channel}`;
      const notificationRepo = manager.getRepository(NotificationEntity);
      const existingNotification = await notificationRepo.findOne({
        where: { idempotencyKey },
        lock: { mode: 'pessimistic_write' },
      });

      if (!existingNotification) {
        await notificationRepo.save(
          notificationRepo.create({
            id: randomUUID(),
            recipientId: command.recipientId,
            orderId: command.orderId,
            eventId: command.eventId,
            correlationId: command.correlationId,
            causationId: command.causationId,
            type: command.type,
            channel: command.channel,
            status: NotificationStatus.PENDING,
            recipientAddress: command.recipientAddress,
            templateKey: command.templateKey,
            subject: command.subject,
            body: command.body,
            retryCount: 0,
            nextRetryAt: null,
            sentAt: null,
            lastError: null,
            providerMessageId: null,
            idempotencyKey,
          }),
        );
      }

      await this.markInboxProcessed(manager, command.eventId);
      return existingNotification ? 'duplicate' : 'created';
    });
  }

  private async isChannelEnabled(
    manager: Parameters<Parameters<DataSource['transaction']>[0]>[0],
    recipientId: string,
    type: NotificationType,
    channel: NotificationChannel,
  ): Promise<boolean> {
    const pref = await manager.getRepository(NotificationPreferenceEntity).findOne({
      where: { recipientId, type, channel },
    });
    return pref === null || pref.isEnabled;
  }

  private async markInboxProcessed(
    manager: Parameters<Parameters<DataSource['transaction']>[0]>[0],
    eventId: string,
  ): Promise<void> {
    const inbox = await manager.getRepository(InboxEventEntity).findOneOrFail({
      where: { eventId },
      lock: { mode: 'pessimistic_write' },
    });
    inbox.status = InboxEventStatus.PROCESSED;
    inbox.processedAt = new Date();
    await manager.getRepository(InboxEventEntity).save(inbox);
  }

  async getAttempts(notificationId: string): Promise<NotificationAttemptEntity[]> {
    return this.dataSource.getRepository(NotificationAttemptEntity).find({
      where: { notificationId },
      order: { attemptedAt: 'ASC' },
    });
  }
}
