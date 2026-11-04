import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { QueryFailedError, DataSource, EntityManager } from 'typeorm';

import {
  InboxEventEntity,
  InboxEventStatus,
} from './entities/inbox-event.entity';

export type InboxProcessingResult = 'processed' | 'duplicate';
export type InboxBusinessOperation = (manager: EntityManager) => Promise<void>;

export class InboxEventInProgressError extends Error {
  constructor(eventId: string) {
    super(`Inbox event ${eventId} is not in a recoverable processed state`);
    this.name = 'InboxEventInProgressError';
  }
}

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(private readonly dataSource: DataSource) {}

  async processOnce(
    eventId: string,
    eventType: string,
    operation: InboxBusinessOperation,
  ): Promise<InboxProcessingResult> {
    this.validateEventIdentity(eventId, eventType);
    let processingBusinessWork = false;

    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.insert(InboxEventEntity, {
          eventId,
          eventType,
          status: InboxEventStatus.PROCESSING,
          processedAt: null,
        });

        processingBusinessWork = true;
        await operation(manager);

        const result = await manager.update(
          InboxEventEntity,
          {
            eventId,
            status: InboxEventStatus.PROCESSING,
          },
          {
            status: InboxEventStatus.PROCESSED,
            processedAt: new Date(),
          },
        );
        if (result.affected !== 1) {
          throw new Error(
            `Inbox processing record for event ${eventId} was not updated`,
          );
        }
      });

      this.logger.log(
        JSON.stringify({
          event: 'inventory.inbox.processed',
          eventId,
          eventType,
        }),
      );
      return 'processed';
    } catch (error) {
      if (processingBusinessWork || !this.isDuplicateKeyError(error)) {
        this.logger.error(
          JSON.stringify({
            event: 'inventory.inbox.processing_failed',
            eventId,
            eventType,
            error: this.errorMessage(error),
          }),
        );
        throw error;
      }

      return this.confirmDuplicate(eventId, eventType);
    }
  }

  private async confirmDuplicate(
    eventId: string,
    eventType: string,
  ): Promise<InboxProcessingResult> {
    const existing = await this.dataSource
      .getRepository(InboxEventEntity)
      .findOneBy({ eventId });

    if (!existing) {
      throw new InboxEventInProgressError(eventId);
    }
    if (existing.eventType !== eventType) {
      throw new Error(
        `Inbox event ID ${eventId} was reused for a different event type`,
      );
    }
    if (existing.status !== InboxEventStatus.PROCESSED) {
      throw new InboxEventInProgressError(eventId);
    }

    this.logger.warn(
      JSON.stringify({
        event: 'inventory.inbox.duplicate_ignored',
        eventId,
        eventType,
      }),
    );
    return 'duplicate';
  }

  private validateEventIdentity(eventId: string, eventType: string): void {
    if (
      typeof eventId !== 'string' ||
      eventId.trim().length === 0 ||
      eventId.length > 36
    ) {
      throw new BadRequestException(
        'eventId must be a non-empty string of at most 36 characters',
      );
    }
    if (
      typeof eventType !== 'string' ||
      eventType.trim().length === 0 ||
      eventType.length > 120
    ) {
      throw new BadRequestException(
        'eventType must be a non-empty string of at most 120 characters',
      );
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const queryError = error as QueryFailedError;
    const driverError: unknown = queryError.driverError;
    const driverCode =
      typeof driverError === 'object' &&
      driverError !== null &&
      'code' in driverError
        ? driverError.code
        : undefined;
    const errorCode = 'code' in error ? error.code : driverCode;
    return errorCode === 'ER_DUP_ENTRY';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
