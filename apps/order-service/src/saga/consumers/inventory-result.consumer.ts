import { Injectable } from '@nestjs/common';
import type {
  InventoryReservationFailedEvent,
  InventoryReservedEvent,
} from 'default/contracts';
import {
  INVENTORY_RESERVATION_FAILURE_CODES,
  INVENTORY_RESERVATION_FAILED_EVENT_TYPE,
  INVENTORY_RESERVED_EVENT_TYPE,
} from 'default/contracts';
import { SagaOrchestratorService } from '../saga-orchestrator.service';
import { isIdentifier, isRecord, validateSagaEvent } from './event-validation';
import { UnprocessableSagaEventError } from './unprocessable-saga-event.error';

@Injectable()
export class InventoryResultConsumer {
  constructor(private readonly orchestrator: SagaOrchestratorService) {}

  async consume(event: unknown): Promise<void> {
    if (!isRecord(event) || !isRecord(event.payload)) {
      throw new UnprocessableSagaEventError('Invalid inventory result event');
    }

    if (event.eventType === INVENTORY_RESERVED_EVENT_TYPE) {
      const validated = validateSagaEvent<InventoryReservedEvent>(
        event,
        INVENTORY_RESERVED_EVENT_TYPE,
      );
      if (
        !isIdentifier(validated.payload.orderId) ||
        !isIdentifier(validated.payload.reservationId) ||
        !Array.isArray(validated.payload.items) ||
        validated.payload.items.some(
          (item) =>
            !isRecord(item) ||
            typeof item.productId !== 'string' ||
            item.productId.trim().length === 0 ||
            item.productId.length > 120 ||
            typeof item.quantity !== 'number' ||
            !Number.isSafeInteger(item.quantity) ||
            item.quantity < 1,
        )
      ) {
        throw new UnprocessableSagaEventError(
          'Invalid inventory.reserved.v1 payload',
        );
      }
      await this.orchestrator.inventoryReserved(validated);
      return;
    }

    if (event.eventType === INVENTORY_RESERVATION_FAILED_EVENT_TYPE) {
      const validated = validateSagaEvent<InventoryReservationFailedEvent>(
        event,
        INVENTORY_RESERVATION_FAILED_EVENT_TYPE,
      );
      if (
        !isIdentifier(validated.payload.orderId) ||
        !INVENTORY_RESERVATION_FAILURE_CODES.includes(
          validated.payload.reasonCode,
        )
      ) {
        throw new UnprocessableSagaEventError(
          'Invalid inventory.reservation_failed.v1 payload',
        );
      }
      await this.orchestrator.inventoryReservationFailed(validated);
      return;
    }

    throw new UnprocessableSagaEventError(
      'Unsupported inventory result event type',
    );
  }
}
