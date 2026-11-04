import { Injectable, Logger } from '@nestjs/common';
import type { InventoryReleaseCommand } from 'default/contracts';
import { INVENTORY_RELEASE_COMMAND_TYPE } from 'default/contracts';
import {
  InboxService,
  type InboxProcessingResult,
} from '../../inbox/inbox.service';
import { ReservationReleaseService } from '../../reservations/compensation/reservation-release.service';

export class UnprocessableInventoryReleaseCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnprocessableInventoryReleaseCommandError';
  }
}

@Injectable()
export class InventoryReleaseConsumer {
  private readonly logger = new Logger(InventoryReleaseConsumer.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly releaseService: ReservationReleaseService,
  ) {}

  async consume(command: unknown): Promise<InboxProcessingResult> {
    const startedAt = Date.now();
    const validated = this.validateCommand(command);
    try {
      const result = await this.inbox.processOnce(
        validated.commandId,
        validated.commandType,
        (manager) => this.releaseService.release(validated, manager),
      );
      this.logger.log(
        JSON.stringify({
          event: 'inventory.release_command.processed',
          result,
          commandId: validated.commandId,
          orderId: validated.payload.orderId,
          sagaId: validated.payload.sagaId,
          compensationStepId: validated.payload.releaseOperationId,
          reservationId: validated.payload.reservationId,
          correlationId: validated.correlationId,
          causationId: validated.causationId,
          durationMs: Date.now() - startedAt,
        }),
      );
      this.logger.log(
        JSON.stringify({
          event: 'inventory.metric',
          metric: 'inventory_release_duration_ms',
          value: Date.now() - startedAt,
          result,
          orderId: validated.payload.orderId,
          sagaId: validated.payload.sagaId,
          compensationStepId: validated.payload.releaseOperationId,
          commandId: validated.commandId,
          correlationId: validated.correlationId,
        }),
      );
      return result;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'inventory.release_command.processing_failed',
          commandId: validated.commandId,
          orderId: validated.payload.orderId,
          sagaId: validated.payload.sagaId,
          compensationStepId: validated.payload.releaseOperationId,
          reservationId: validated.payload.reservationId,
          correlationId: validated.correlationId,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  }

  private validateCommand(value: unknown): InventoryReleaseCommand {
    if (!this.isRecord(value) || !this.isRecord(value.payload)) {
      throw new UnprocessableInventoryReleaseCommandError(
        'Invalid inventory.release.v1 command envelope or payload',
      );
    }
    const payload = value.payload;
    if (
      value.commandType !== INVENTORY_RELEASE_COMMAND_TYPE ||
      value.eventVersion !== 1 ||
      !this.isIdentifier(value.commandId) ||
      !this.isIdentifier(value.aggregateId) ||
      !this.isIdentifier(value.correlationId) ||
      (value.causationId !== null && !this.isIdentifier(value.causationId)) ||
      typeof value.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(value.occurredAt)) ||
      !this.isIdentifier(payload.orderId) ||
      payload.orderId !== value.aggregateId ||
      !this.isIdentifier(payload.sagaId) ||
      !this.isIdentifier(payload.reservationId) ||
      !this.isIdentifier(payload.releaseOperationId) ||
      typeof payload.reasonCode !== 'string' ||
      !/^[A-Z0-9_]{1,100}$/.test(payload.reasonCode)
    ) {
      throw new UnprocessableInventoryReleaseCommandError(
        'Invalid inventory.release.v1 command envelope or payload',
      );
    }
    return value as unknown as InventoryReleaseCommand;
  }

  private isIdentifier(value: unknown): value is string {
    return (
      typeof value === 'string' && value.trim().length > 0 && value.length <= 36
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
