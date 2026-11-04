import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  InventoryReleaseCommand,
  InventoryReleaseFailedEvent,
  InventoryReleasedEvent,
} from 'default/contracts';
import {
  INVENTORY_RELEASE_FAILED_EVENT_TYPE,
  INVENTORY_RELEASED_EVENT_TYPE,
} from 'default/contracts';
import type { EntityManager } from 'typeorm';
import { OutboxEventEntity } from '../../outbox/entities/outbox-event.entity';
import { ReservationsService } from '../reservations.service';

@Injectable()
export class ReservationReleaseService {
  constructor(private readonly reservations: ReservationsService) {}

  async release(
    command: InventoryReleaseCommand,
    manager: EntityManager,
  ): Promise<void> {
    let release: Awaited<ReturnType<ReservationsService['releaseReservation']>>;
    try {
      release = await this.reservations.releaseReservation(
        command.payload.reservationId,
        command.payload.orderId,
        manager,
        command.payload.releaseOperationId,
      );
    } catch (error) {
      if (
        !(error instanceof NotFoundException) &&
        !(error instanceof ConflictException)
      ) {
        throw error;
      }

      const event: InventoryReleaseFailedEvent = {
        eventId: randomUUID(),
        eventType: INVENTORY_RELEASE_FAILED_EVENT_TYPE,
        eventVersion: 1,
        aggregateId: command.payload.orderId,
        occurredAt: new Date().toISOString(),
        correlationId: command.correlationId,
        causationId: command.commandId,
        payload: {
          orderId: command.payload.orderId,
          sagaId: command.payload.sagaId,
          reservationId: command.payload.reservationId,
          releaseOperationId: command.payload.releaseOperationId,
          reasonCode:
            error instanceof NotFoundException
              ? 'RESERVATION_NOT_FOUND'
              : 'RESERVATION_NOT_RELEASABLE',
          reason: this.failureReason(error),
        },
      };
      await this.saveResult(manager, event);
      return;
    }

    const event: InventoryReleasedEvent = {
      eventId: randomUUID(),
      eventType: INVENTORY_RELEASED_EVENT_TYPE,
      eventVersion: 1,
      aggregateId: command.payload.orderId,
      occurredAt: new Date().toISOString(),
      correlationId: command.correlationId,
      causationId: command.commandId,
      payload: {
        orderId: command.payload.orderId,
        sagaId: command.payload.sagaId,
        reservationId: command.payload.reservationId,
        releaseOperationId: command.payload.releaseOperationId,
        releasedItems: release.items,
      },
    };
    await this.saveResult(manager, event);
  }

  private async saveResult(
    manager: EntityManager,
    event: InventoryReleasedEvent | InventoryReleaseFailedEvent,
  ): Promise<void> {
    const repository = manager.getRepository(OutboxEventEntity);
    await repository.save(
      repository.create({
        id: event.eventId,
        aggregateType: 'InventoryReservation',
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: { ...event },
        publishedAt: null,
      }),
    );
  }

  private failureReason(error: ConflictException | NotFoundException): string {
    const message =
      error.message || 'Inventory reservation could not be released';
    return message.slice(0, 1000);
  }
}
