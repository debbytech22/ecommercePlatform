import { Injectable } from '@nestjs/common';
import type {
  InventoryReleaseFailedEvent,
  InventoryReleasedEvent,
} from 'default/contracts';
import {
  INVENTORY_RELEASED_EVENT_TYPE,
  INVENTORY_RELEASE_FAILED_EVENT_TYPE,
} from 'default/contracts';
import { SagaOrchestratorService } from '../saga-orchestrator.service';
import { isIdentifier, isRecord, validateSagaEvent } from './event-validation';
import { UnprocessableSagaEventError } from './unprocessable-saga-event.error';

@Injectable()
export class InventoryReleaseResultConsumer {
  constructor(private readonly orchestrator: SagaOrchestratorService) {}

  async consume(event: unknown): Promise<void> {
    if (!isRecord(event) || !isRecord(event.payload)) {
      throw new UnprocessableSagaEventError(
        'Invalid compensation result event',
      );
    }

    if (event.eventType === INVENTORY_RELEASED_EVENT_TYPE) {
      const validated = validateSagaEvent<InventoryReleasedEvent>(
        event,
        INVENTORY_RELEASED_EVENT_TYPE,
      );
      if (
        !isIdentifier(validated.payload.orderId) ||
        !isIdentifier(validated.payload.sagaId) ||
        !isIdentifier(validated.payload.reservationId) ||
        !isIdentifier(validated.payload.releaseOperationId) ||
        !Array.isArray(validated.payload.releasedItems) ||
        validated.payload.releasedItems.some(
          (item) =>
            !isRecord(item) ||
            typeof item.productId !== 'string' ||
            item.productId.trim().length === 0 ||
            !Number.isSafeInteger(item.quantity) ||
            item.quantity <= 0,
        )
      ) {
        throw new UnprocessableSagaEventError(
          'Invalid inventory.released.v1 payload',
        );
      }
      await this.orchestrator.inventoryReleased(validated);
      return;
    }

    if (event.eventType === INVENTORY_RELEASE_FAILED_EVENT_TYPE) {
      const validated = validateSagaEvent<InventoryReleaseFailedEvent>(
        event,
        INVENTORY_RELEASE_FAILED_EVENT_TYPE,
      );
      if (
        !isIdentifier(validated.payload.orderId) ||
        !isIdentifier(validated.payload.sagaId) ||
        !isIdentifier(validated.payload.reservationId) ||
        !isIdentifier(validated.payload.releaseOperationId) ||
        typeof validated.payload.reasonCode !== 'string' ||
        !/^[A-Z0-9_]{1,100}$/.test(validated.payload.reasonCode) ||
        typeof validated.payload.reason !== 'string' ||
        validated.payload.reason.length > 1000
      ) {
        throw new UnprocessableSagaEventError(
          'Invalid inventory.release_failed.v1 payload',
        );
      }
      await this.orchestrator.inventoryReleaseFailed(validated);
      return;
    }

    throw new UnprocessableSagaEventError(
      'Unsupported compensation result event type',
    );
  }
}
