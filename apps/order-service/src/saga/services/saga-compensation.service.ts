import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import {
  INVENTORY_RELEASE_COMMAND_TYPE,
  PAYMENT_RECONCILE_COMMAND_TYPE,
  PAYMENT_REFUND_COMMAND_TYPE,
  PAYMENT_VOID_COMMAND_TYPE,
} from 'default/contracts';
import { OutboxEventEntity } from '../../entities/outbox-event.entity';
import { OrderEntity } from '../../entities/order.entity';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaStepEntity, SagaStepType } from '../entities/saga-step.entity';
import { SagaState } from '../enums/saga-state.enum';
import { SagaStepStatus } from '../enums/saga-step-status.enum';
import { CompensationStatus } from '../compensation/compensation.types';
import {
  SAGA_TIMEOUT_CONFIG,
  type SagaTimeoutConfig,
} from '../config/saga-timeout.config';

@Injectable()
export class SagaCompensationService {
  private readonly logger = new Logger(SagaCompensationService.name);

  constructor(
    @Inject(SAGA_TIMEOUT_CONFIG)
    private readonly timeouts: SagaTimeoutConfig,
  ) {}

  async requestPaymentRefund(
    manager: EntityManager,
    saga: OrderSagaEntity,
    causationId: string,
    retryDelayMs = 0,
  ): Promise<void> {
    if (!saga.paymentOperationId) {
      throw new Error(
        `Saga ${saga.id} cannot refund without a payment operation ID`,
      );
    }
    const order = await manager
      .getRepository(OrderEntity)
      .findOneByOrFail({ id: saga.orderId });

    await this.publishCompensationCommand(
      manager,
      saga,
      SagaStepType.PAYMENT_REFUND,
      PAYMENT_REFUND_COMMAND_TYPE,
      {
        orderId: saga.orderId,
        sagaId: saga.id,
        paymentOperationId: saga.paymentOperationId,
        amount: order.totalAmount,
        currency: order.currency,
        reasonCode: saga.failureCode ?? 'ORDER_COMPENSATION',
      },
      causationId,
      SagaState.COMPENSATION_PENDING,
      retryDelayMs,
    );
  }

  async requestPaymentVoid(
    manager: EntityManager,
    saga: OrderSagaEntity,
    authorizationId: string,
    causationId: string,
    retryDelayMs = 0,
  ): Promise<void> {
    if (!saga.paymentOperationId) {
      throw new Error(
        `Saga ${saga.id} cannot void without a payment operation ID`,
      );
    }

    await this.publishCompensationCommand(
      manager,
      saga,
      SagaStepType.PAYMENT_VOID,
      PAYMENT_VOID_COMMAND_TYPE,
      {
        orderId: saga.orderId,
        sagaId: saga.id,
        paymentOperationId: saga.paymentOperationId,
        authorizationId,
        reasonCode: saga.failureCode ?? 'ORDER_COMPENSATION',
      },
      causationId,
      SagaState.COMPENSATION_PENDING,
      retryDelayMs,
    );
  }

  async requestPaymentReconciliation(
    manager: EntityManager,
    saga: OrderSagaEntity,
    causationId: string,
  ): Promise<void> {
    if (!saga.paymentOperationId) {
      throw new Error(
        `Saga ${saga.id} cannot reconcile without a payment operation ID`,
      );
    }

    await this.publishCompensationCommand(
      manager,
      saga,
      SagaStepType.PAYMENT_RECONCILIATION,
      PAYMENT_RECONCILE_COMMAND_TYPE,
      {
        orderId: saga.orderId,
        paymentOperationId: saga.paymentOperationId,
      },
      causationId,
      SagaState.MANUAL_INTERVENTION_REQUIRED,
    );
  }

  async requestInventoryRelease(
    manager: EntityManager,
    saga: OrderSagaEntity,
    reasonCode: string,
    causationId: string,
    retryDelayMs = 0,
  ): Promise<void> {
    if (!saga.inventoryReservationId) {
      throw new Error(
        `Saga ${saga.id} cannot release inventory without a reservation ID`,
      );
    }
    const step = await manager.getRepository(SagaStepEntity).findOneByOrFail({
      sagaId: saga.id,
      stepType: SagaStepType.INVENTORY_RELEASE,
    });

    await this.publishCompensationCommand(
      manager,
      saga,
      SagaStepType.INVENTORY_RELEASE,
      INVENTORY_RELEASE_COMMAND_TYPE,
      {
        orderId: saga.orderId,
        sagaId: saga.id,
        reservationId: saga.inventoryReservationId,
        releaseOperationId: step.operationId ?? step.id,
        reasonCode,
      },
      causationId,
      SagaState.COMPENSATION_PENDING,
      retryDelayMs,
    );
  }

  private async publishCompensationCommand(
    manager: EntityManager,
    saga: OrderSagaEntity,
    stepType: SagaStepType,
    eventType: string,
    payload: Record<string, string>,
    causationId: string,
    nextState: SagaState = SagaState.COMPENSATION_PENDING,
    retryDelayMs = 0,
  ): Promise<void> {
    const steps = manager.getRepository(SagaStepEntity);
    const step = await steps.findOneByOrFail({ sagaId: saga.id, stepType });
    if (step.status === SagaStepStatus.IN_PROGRESS && step.commandId !== null) {
      return;
    }

    const commandId = step.commandId ?? randomUUID();
    const operationId = step.operationId ?? step.id;
    step.commandId = commandId;
    step.operationId = operationId;
    step.status = SagaStepStatus.IN_PROGRESS;
    step.attemptCount += 1;
    step.lastError = null;
    step.startedAt ??= new Date();
    step.deadlineAt = new Date(Date.now() + this.stepTimeoutMs(stepType));
    step.nextRetryAt = new Date(Date.now() + retryDelayMs);
    step.completedAt = null;
    await steps.save(step);

    saga.currentState = nextState;
    saga.compensationStatus =
      nextState === SagaState.MANUAL_INTERVENTION_REQUIRED
        ? CompensationStatus.MANUAL_INTERVENTION_REQUIRED
        : CompensationStatus.IN_PROGRESS;
    await manager.getRepository(OrderSagaEntity).save(saga);

    const commandPayload = { ...payload };
    if (eventType === PAYMENT_REFUND_COMMAND_TYPE) {
      commandPayload.refundOperationId = operationId;
    } else if (eventType === PAYMENT_VOID_COMMAND_TYPE) {
      commandPayload.voidOperationId = operationId;
    }

    const outbox = manager.getRepository(OutboxEventEntity);
    await outbox.save(
      outbox.create({
        id: randomUUID(),
        commandId,
        aggregateType: 'Order',
        aggregateId: saga.orderId,
        eventType,
        payload: {
          commandId,
          commandType: eventType,
          eventVersion: 1,
          aggregateId: saga.orderId,
          occurredAt: new Date().toISOString(),
          correlationId: saga.correlationId,
          causationId,
          payload: commandPayload,
        },
        publishedAt: null,
        attempts: 0,
        nextAttemptAt: new Date(Date.now() + retryDelayMs),
        lastError: null,
      }),
    );
    this.logger.log(
      JSON.stringify({
        event: 'saga.compensation.command_staged',
        deadlineAt: step.deadlineAt,
        orderId: saga.orderId,
        sagaId: saga.id,
        stepId: step.id,
        stepType,
        commandId,
        operationId,
        correlationId: saga.correlationId,
        causationId,
        attempt: step.attemptCount,
        nextRetryAt: step.nextRetryAt,
      }),
    );
  }

  private stepTimeoutMs(stepType: SagaStepType): number {
    switch (stepType) {
      case SagaStepType.PAYMENT_VOID:
        return this.timeouts.paymentVoidMs;
      case SagaStepType.PAYMENT_REFUND:
        return this.timeouts.paymentRefundMs;
      case SagaStepType.INVENTORY_RELEASE:
        return this.timeouts.inventoryReleaseMs;
      case SagaStepType.PAYMENT_RECONCILIATION:
        return this.timeouts.paymentCaptureMs;
      default:
        return this.timeouts.inventoryReleaseMs;
    }
  }
}
