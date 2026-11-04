import { Injectable, Logger } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import type {
  InventoryReleaseFailedEvent,
  InventoryReleasedEvent,
  InventoryReservationFailedEvent,
  InventoryReservedEvent,
  PaymentAuthorizationUncertainEvent,
  PaymentAuthorizationFailedEvent,
  PaymentAuthorizedEvent,
  PaymentReconciledEvent,
  PaymentRefundFailedEvent,
  PaymentRefundedEvent,
  PaymentVoidFailedEvent,
  PaymentVoidedEvent,
} from 'default/contracts';
import {
  INVENTORY_RELEASE_COMMAND_TYPE,
  PAYMENT_AUTHORIZE_COMMAND_TYPE,
  PAYMENT_REFUND_COMMAND_TYPE,
  PAYMENT_VOID_COMMAND_TYPE,
} from 'default/contracts';
import { DataSource, EntityManager } from 'typeorm';
import { InboxEventEntity } from '../inbox/inbox-event.entity';
import { OrderEntity, OrderStatus } from '../entities/order.entity';
import { OrderItemEntity } from '../entities/order-item.entity';
import { OutboxEventEntity } from '../entities/outbox-event.entity';
import { SagaState } from './enums/saga-state.enum';
import { SagaStepStatus } from './enums/saga-step-status.enum';
import { OrderSagaEntity } from './entities/order-saga.entity';
import { SagaStepEntity, SagaStepType } from './entities/saga-step.entity';
import { SagaTransitionValidator } from './saga-transition.validator';
import { SagaCompensationService } from './services/saga-compensation.service';
import { PaymentResultProcessor } from './confirmation/payment-result.processor';
import { CompensationOrchestratorService } from './compensation/compensation-orchestrator.service';
import {
  CompensationReason,
  CompensationStatus,
} from './compensation/compensation.types';
import { OrderConfirmationMetricsService } from './confirmation/order-confirmation-metrics.service';
import { OrderStatusHistoryService } from '../orders/order-status-history.service';

type SagaEvent = {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
};

class StaleSagaCommandEventError extends Error {
  constructor(readonly stepType: SagaStepType) {
    super('Saga result does not reference the active command');
  }
}

const MAX_COMPENSATION_ATTEMPTS = 3;
const COMPENSATION_RETRY_BASE_DELAY_MS = 1000;
const COMPENSATION_RETRY_MAX_DELAY_MS = 30000;
const WORKFLOW_STEP_TIMEOUT_MS = 60_000;

@Injectable()
export class SagaOrchestratorService {
  private readonly logger = new Logger(SagaOrchestratorService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly compensation: SagaCompensationService,
    private readonly paymentResultProcessor: PaymentResultProcessor,
    private readonly compensationOrchestrator: CompensationOrchestratorService,
    private readonly confirmationMetrics: OrderConfirmationMetricsService,
  ) {}

  inventoryReserved(event: InventoryReservedEvent): Promise<void> {
    return this.process(event, async (manager) => {
      const saga = await this.lockSaga(manager, event.payload.orderId, event);
      if (saga.currentState !== SagaState.INVENTORY_RESERVATION_PENDING) {
        await this.handleUnexpectedState(
          manager,
          saga,
          SagaStepType.INVENTORY_RESERVATION,
          event,
          SagaState.INVENTORY_RESERVATION_PENDING,
        );
        return;
      }
      if (event.causationId !== saga.correlationId) {
        throw new Error(
          'Inventory result does not causally reference the order',
        );
      }
      const requestedItems = await manager
        .getRepository(OrderItemEntity)
        .find({ where: { order: { id: saga.orderId } } });
      const reservedItems = [...event.payload.items]
        .map(({ productId, quantity }) => ({ productId, quantity }))
        .sort((left, right) => left.productId.localeCompare(right.productId));
      const expectedItems = requestedItems
        .map(({ productId, quantity }) => ({ productId, quantity }))
        .sort((left, right) => left.productId.localeCompare(right.productId));
      if (
        reservedItems.length !== expectedItems.length ||
        reservedItems.some(
          (item, index) =>
            item.productId !== expectedItems[index].productId ||
            item.quantity !== expectedItems[index].quantity,
        )
      ) {
        throw new Error(
          'Inventory reservation items do not match the persisted order',
        );
      }

      SagaTransitionValidator.assertAllowed(
        saga.currentState,
        SagaState.INVENTORY_RESERVED,
      );
      saga.currentState = SagaState.INVENTORY_RESERVED;
      saga.inventoryReservationId = event.payload.reservationId;
      saga.inventoryReservationStatus = 'RESERVED';
      saga.inventoryReservationItems = reservedItems;
      await manager.getRepository(OrderSagaEntity).save(saga);
      await this.completeStep(
        manager,
        saga.id,
        SagaStepType.INVENTORY_RESERVATION,
      );

      SagaTransitionValidator.assertAllowed(
        saga.currentState,
        SagaState.PAYMENT_PENDING,
      );
      saga.currentState = SagaState.PAYMENT_PENDING;
      const paymentOperationId = randomUUID();
      saga.paymentOperationId = paymentOperationId;
      await manager.getRepository(OrderSagaEntity).save(saga);

      const order = await manager.getRepository(OrderEntity).findOneByOrFail({
        id: saga.orderId,
      });
      await OrderStatusHistoryService.transition(
        manager,
        order,
        OrderStatus.PROCESSING_PAYMENT,
        {
          reasonCode: 'INVENTORY_RESERVED',
          reason: 'Inventory reserved; payment processing started',
          correlationId: event.correlationId,
          causationId: event.eventId,
        },
      );
      await this.createCommand(
        manager,
        saga,
        SagaStepType.PAYMENT_AUTHORIZATION,
        PAYMENT_AUTHORIZE_COMMAND_TYPE,
        {
          orderId: order.id,
          customerId: order.customerId,
          amount: order.totalAmount,
          currency: order.currency,
          paymentOperationId,
        },
        event.eventId,
      );
    });
  }

  inventoryReservationFailed(
    event: InventoryReservationFailedEvent,
  ): Promise<void> {
    return this.process(event, async (manager) => {
      const saga = await this.lockSaga(manager, event.payload.orderId, event);
      if (saga.currentState !== SagaState.INVENTORY_RESERVATION_PENDING) {
        await this.handleUnexpectedState(
          manager,
          saga,
          SagaStepType.INVENTORY_RESERVATION,
          event,
          SagaState.INVENTORY_RESERVATION_PENDING,
        );
        return;
      }
      if (event.causationId !== saga.correlationId) {
        throw new Error(
          'Inventory failure does not causally reference the order',
        );
      }
      SagaTransitionValidator.assertAllowed(
        saga.currentState,
        SagaState.FAILED,
      );
      saga.currentState = SagaState.FAILED;
      saga.failureCode = event.payload.reasonCode;
      saga.failureReason = event.payload.reason.slice(0, 1000);
      saga.completedAt = new Date();
      await manager.getRepository(OrderSagaEntity).save(saga);
      await this.completeStep(
        manager,
        saga.id,
        SagaStepType.INVENTORY_RESERVATION,
        SagaStepStatus.FAILED,
        event.payload.reasonCode,
      );
      const order = await manager.getRepository(OrderEntity).findOneByOrFail({
        id: saga.orderId,
      });
      await OrderStatusHistoryService.transition(
        manager,
        order,
        OrderStatus.FAILED,
        {
          reasonCode: event.payload.reasonCode,
          reason: 'Inventory reservation failed',
          correlationId: event.correlationId,
          causationId: event.eventId,
        },
      );
    });
  }

  async paymentAuthorized(event: PaymentAuthorizedEvent): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.process(event, async (manager) => {
        const saga = await this.lockSaga(manager, event.payload.orderId, event);
        if (
          saga.currentState !== SagaState.PAYMENT_PENDING &&
          saga.currentState !== SagaState.COMPLETED
        ) {
          await this.compensateLateAuthorization(manager, saga, event);
          return { outcome: 'late_compensated' as const, sagaId: saga.id };
        }
        return this.paymentResultProcessor.processAuthorization(manager, event);
      });
      const durationMs = Date.now() - startedAt;
      if (!result) {
        this.confirmationMetrics.recordOutcome('duplicate', durationMs);
        this.logger.warn(
          JSON.stringify({
            event: 'order.confirmation.duplicate_event_ignored',
            orderId: event.payload.orderId,
            paymentOperationId: event.payload.paymentOperationId,
            paymentEventId: event.eventId,
            correlationId: event.correlationId,
            durationMs,
          }),
        );
        return;
      }

      if (result.outcome === 'late_compensated') {
        this.logger.warn(
          JSON.stringify({
            event: 'saga.payment.late_authorization_compensated',
            orderId: event.payload.orderId,
            sagaId: result.sagaId,
            paymentOperationId: event.payload.paymentOperationId,
            commandId: event.causationId,
            correlationId: event.correlationId,
          }),
        );
        return;
      }

      this.confirmationMetrics.recordOutcome(result.outcome, durationMs);
      this.logger.log(
        JSON.stringify({
          event:
            result.outcome === 'confirmed'
              ? 'order.confirmation.transaction_committed'
              : 'order.confirmation.duplicate_ignored',
          orderId: event.payload.orderId,
          sagaId: result.sagaId,
          inventoryReservationId: result.inventoryReservationId,
          paymentOperationId: event.payload.paymentOperationId,
          confirmationEventId: result.confirmationEventId,
          paymentEventId: event.eventId,
          correlationId: event.correlationId,
          durationMs,
        }),
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.confirmationMetrics.recordFailure(durationMs);
      this.logger.error(
        JSON.stringify({
          event: 'order.confirmation.transaction_failed',
          orderId: event.payload.orderId,
          paymentOperationId: event.payload.paymentOperationId,
          paymentEventId: event.eventId,
          correlationId: event.correlationId,
          durationMs,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  }

  private async compensateLateAuthorization(
    manager: EntityManager,
    saga: OrderSagaEntity,
    event: PaymentAuthorizedEvent,
  ): Promise<void> {
    if (
      ![
        SagaState.COMPENSATION_REQUIRED,
        SagaState.COMPENSATING,
        SagaState.COMPENSATION_PENDING,
        SagaState.COMPENSATION_PARTIALLY_COMPLETED,
        SagaState.COMPENSATION_FAILED,
        SagaState.COMPENSATED,
        SagaState.MANUAL_INTERVENTION_REQUIRED,
      ].includes(saga.currentState)
    ) {
      await this.handleUnexpectedState(
        manager,
        saga,
        SagaStepType.PAYMENT_AUTHORIZATION,
        event,
        SagaState.PAYMENT_PENDING,
        'Payment authorization succeeded after the forward workflow stopped',
      );
      return;
    }

    const [order, paymentStep, voidStep] = await Promise.all([
      manager.getRepository(OrderEntity).findOneByOrFail({
        id: saga.orderId,
      }),
      manager.getRepository(SagaStepEntity).findOneByOrFail({
        sagaId: saga.id,
        stepType: SagaStepType.PAYMENT_AUTHORIZATION,
      }),
      manager.getRepository(SagaStepEntity).findOneByOrFail({
        sagaId: saga.id,
        stepType: SagaStepType.PAYMENT_VOID,
      }),
    ]);
    if (
      saga.paymentOperationId !== event.payload.paymentOperationId ||
      paymentStep.commandId !== event.causationId ||
      order.totalAmount !== event.payload.amount ||
      order.currency !== event.payload.currency ||
      (saga.paymentId !== null && saga.paymentId !== event.payload.paymentId) ||
      (saga.paymentAuthorizationId !== null &&
        saga.paymentAuthorizationId !== event.payload.authorizationId)
    ) {
      throw new Error(
        'Late payment authorization does not match the persisted Saga operation',
      );
    }

    if (
      voidStep.status === SagaStepStatus.SUCCEEDED ||
      voidStep.status === SagaStepStatus.COMPENSATED
    ) {
      return;
    }

    saga.paymentId = event.payload.paymentId;
    saga.paymentAuthorizationId = event.payload.authorizationId;
    saga.paymentAmount = event.payload.amount;
    saga.paymentCurrency = event.payload.currency;
    saga.paymentStatus = 'AUTHORIZED';
    saga.completedAt = null;
    saga.compensationCompletedAt = null;
    saga.compensationReason ??= CompensationReason.PAYMENT_PROCESSING_FAILED;
    saga.compensationStartedAt ??= new Date();
    saga.compensationStatus = CompensationStatus.IN_PROGRESS;
    if (saga.currentState !== SagaState.COMPENSATING) {
      SagaTransitionValidator.assertAllowed(
        saga.currentState,
        SagaState.COMPENSATING,
      );
    }
    saga.currentState = SagaState.COMPENSATING;
    await manager.getRepository(OrderSagaEntity).save(saga);

    if (
      paymentStep.status !== SagaStepStatus.SUCCEEDED &&
      paymentStep.status !== SagaStepStatus.COMPENSATED
    ) {
      paymentStep.status = SagaStepStatus.SUCCEEDED;
      paymentStep.completedAt = new Date();
      paymentStep.deadlineAt = null;
      paymentStep.lastError = null;
      await manager.getRepository(SagaStepEntity).save(paymentStep);
    }

    if (voidStep.status === SagaStepStatus.IN_PROGRESS) {
      return;
    }
    if (voidStep.attemptCount >= MAX_COMPENSATION_ATTEMPTS) {
      await this.requireManualIntervention(
        manager,
        saga,
        SagaStepType.PAYMENT_VOID,
        'LATE_AUTHORIZATION_VOID_RETRIES_EXHAUSTED',
        'Late payment authorization could not be voided automatically',
      );
      return;
    }

    voidStep.commandId = null;
    voidStep.status = SagaStepStatus.PENDING;
    await manager.getRepository(SagaStepEntity).save(voidStep);
    await OrderStatusHistoryService.transition(
      manager,
      order,
      OrderStatus.CANCELLATION_PENDING,
      {
        reasonCode: 'LATE_PAYMENT_AUTHORIZATION',
        reason: 'Late payment authorization requires compensation',
        correlationId: event.correlationId,
        causationId: event.eventId,
      },
    );
    await this.compensation.requestPaymentVoid(
      manager,
      saga,
      event.payload.authorizationId,
      event.eventId,
    );
  }

  paymentAuthorizationFailed(
    event: PaymentAuthorizationFailedEvent,
  ): Promise<void> {
    return this.process(event, async (manager) => {
      const saga = await this.lockSaga(manager, event.payload.orderId, event);
      if (saga.currentState !== SagaState.PAYMENT_PENDING) {
        await this.handleUnexpectedState(
          manager,
          saga,
          SagaStepType.PAYMENT_AUTHORIZATION,
          event,
          SagaState.PAYMENT_PENDING,
        );
        return;
      }
      if (saga.paymentOperationId !== event.payload.paymentOperationId) {
        throw new Error('Payment operation does not match the Saga command');
      }
      await this.assertCausation(
        manager,
        saga.id,
        SagaStepType.PAYMENT_AUTHORIZATION,
        event,
      );
      SagaTransitionValidator.assertAllowed(
        saga.currentState,
        SagaState.COMPENSATING,
      );
      saga.currentState = SagaState.COMPENSATING;
      saga.failureCode = event.payload.reasonCode;
      saga.failureReason = event.payload.reason.slice(0, 1000);
      saga.compensationReason = CompensationReason.PAYMENT_AUTHORIZATION_FAILED;
      saga.compensationStatus = CompensationStatus.REQUIRED;
      saga.compensationStartedAt ??= new Date();
      saga.compensationCompletedAt = null;
      saga.compensationFailureReason = null;
      saga.compensationCausationId = event.eventId;
      await manager.getRepository(OrderSagaEntity).save(saga);
      await this.completeStep(
        manager,
        saga.id,
        SagaStepType.PAYMENT_AUTHORIZATION,
        SagaStepStatus.FAILED,
        event.payload.reasonCode,
      );
      await this.markOrderCancellationPending(
        manager,
        saga,
        event.eventId,
        event.payload.reasonCode,
        'Payment authorization failed; compensation started',
      );
      await this.compensation.requestInventoryRelease(
        manager,
        saga,
        event.payload.reasonCode,
        event.eventId,
      );
    });
  }

  paymentAuthorizationUncertain(
    event: PaymentAuthorizationUncertainEvent,
  ): Promise<void> {
    return this.process(event, async (manager) => {
      const saga = await this.lockSaga(manager, event.payload.orderId, event);
      if (saga.currentState !== SagaState.PAYMENT_PENDING) {
        await this.handleUnexpectedState(
          manager,
          saga,
          SagaStepType.PAYMENT_AUTHORIZATION,
          event,
          SagaState.PAYMENT_PENDING,
        );
        return;
      }
      if (saga.paymentOperationId !== event.payload.paymentOperationId) {
        throw new Error('Payment operation does not match the Saga command');
      }
      await this.assertCausation(
        manager,
        saga.id,
        SagaStepType.PAYMENT_AUTHORIZATION,
        event,
      );

      SagaTransitionValidator.assertAllowed(
        saga.currentState,
        SagaState.MANUAL_INTERVENTION_REQUIRED,
      );
      saga.currentState = SagaState.MANUAL_INTERVENTION_REQUIRED;
      saga.failureCode = event.payload.reasonCode;
      saga.failureReason = event.payload.reason.slice(0, 1000);
      await manager.getRepository(OrderSagaEntity).save(saga);
      await this.markOrderForReconciliation(
        manager,
        saga,
        event.eventId,
        event.payload.reasonCode,
        'Payment authorization outcome is uncertain',
      );
      await this.compensation.requestPaymentReconciliation(
        manager,
        saga,
        event.eventId,
      );
      this.logOperationalAlert('payment.authorization_outcome_uncertain', {
        sagaId: saga.id,
        orderId: saga.orderId,
        paymentOperationId: saga.paymentOperationId,
      });
    });
  }

  paymentReconciled(event: PaymentReconciledEvent): Promise<void> {
    return this.process(event, async (manager) => {
      const saga = await this.lockSaga(manager, event.payload.orderId, event);
      if (saga.currentState !== SagaState.MANUAL_INTERVENTION_REQUIRED) {
        await this.handleUnexpectedState(
          manager,
          saga,
          SagaStepType.PAYMENT_RECONCILIATION,
          event,
          SagaState.MANUAL_INTERVENTION_REQUIRED,
        );
        return;
      }
      if (saga.paymentOperationId !== event.payload.paymentOperationId) {
        throw new Error('Payment operation does not match the Saga command');
      }
      await this.assertCausation(
        manager,
        saga.id,
        SagaStepType.PAYMENT_RECONCILIATION,
        event,
      );
      if (event.payload.reconciliationCommandId !== event.causationId) {
        throw new Error('Payment reconciliation command does not match Saga');
      }

      if (
        (event.payload.status === 'AUTHORIZED' ||
          event.payload.status === 'CAPTURED') &&
        !event.payload.authorizationId
      ) {
        throw new Error(
          'Payment reconciliation result is missing its authorization ID',
        );
      }
      if (event.payload.authorizationId) {
        saga.paymentAuthorizationId = event.payload.authorizationId;
      }
      if (
        event.payload.status === 'PENDING' ||
        event.payload.status === 'UNKNOWN'
      ) {
        saga.failureCode =
          event.payload.reasonCode ?? 'PAYMENT_OUTCOME_UNKNOWN';
        saga.failureReason = (
          event.payload.reason ??
          'Payment provider could not confirm the authorization outcome'
        ).slice(0, 1000);
        await manager.getRepository(OrderSagaEntity).save(saga);
        await this.completeStep(
          manager,
          saga.id,
          SagaStepType.PAYMENT_RECONCILIATION,
          SagaStepStatus.MANUAL_INTERVENTION_REQUIRED,
          saga.failureCode,
        );
        await this.markOrderForReconciliation(
          manager,
          saga,
          event.eventId,
          event.payload.reasonCode ?? 'PAYMENT_OUTCOME_UNKNOWN',
          'Payment reconciliation remains inconclusive',
        );
        this.logOperationalAlert('payment.reconciliation_inconclusive', {
          sagaId: saga.id,
          orderId: saga.orderId,
          paymentOperationId: saga.paymentOperationId,
          status: event.payload.status,
        });
        return;
      }

      await this.completeStep(
        manager,
        saga.id,
        SagaStepType.PAYMENT_RECONCILIATION,
      );

      SagaTransitionValidator.assertAllowed(
        saga.currentState,
        SagaState.COMPENSATING,
      );
      saga.currentState = SagaState.COMPENSATING;
      saga.failureCode ??= 'PAYMENT_OUTCOME_RECONCILED';
      saga.failureReason ??= 'Payment outcome reconciled; compensating order';
      saga.compensationReason ??= CompensationReason.PAYMENT_PROCESSING_FAILED;
      saga.compensationStatus = CompensationStatus.REQUIRED;
      saga.compensationStartedAt ??= new Date();
      saga.compensationCompletedAt = null;
      saga.compensationFailureReason = null;
      saga.compensationCausationId = event.eventId;
      await manager.getRepository(OrderSagaEntity).save(saga);
      await this.markOrderCancellationPending(
        manager,
        saga,
        event.eventId,
        saga.failureCode ?? 'PAYMENT_OUTCOME_RECONCILED',
        'Reconciled payment result requires compensation',
      );
      if (event.payload.status === 'AUTHORIZED') {
        await this.compensation.requestPaymentVoid(
          manager,
          saga,
          event.payload.authorizationId!,
          event.eventId,
        );
      } else if (event.payload.status === 'CAPTURED') {
        await this.compensation.requestPaymentRefund(
          manager,
          saga,
          event.eventId,
        );
      } else {
        await this.compensation.requestInventoryRelease(
          manager,
          saga,
          saga.failureCode,
          event.eventId,
        );
      }
    });
  }

  paymentRefunded(event: PaymentRefundedEvent): Promise<void> {
    return this.process(event, async (manager) => {
      const saga = await this.lockSaga(manager, event.payload.orderId, event);
      this.assertCompensationSagaId(saga, event.payload.sagaId);
      if (
        await this.ignoreStaleCompensationResult(
          manager,
          saga,
          SagaStepType.PAYMENT_REFUND,
          event,
          event.payload.refundOperationId,
          true,
        )
      ) {
        return;
      }
      if (
        saga.currentState !== SagaState.COMPENSATION_PENDING &&
        saga.currentState !== SagaState.COMPENSATION_PARTIALLY_COMPLETED &&
        saga.currentState !== SagaState.MANUAL_INTERVENTION_REQUIRED
      ) {
        await this.handleUnexpectedState(
          manager,
          saga,
          SagaStepType.PAYMENT_REFUND,
          event,
          SagaState.COMPENSATION_PENDING,
        );
        return;
      }
      if (
        saga.paymentId !== event.payload.paymentId ||
        saga.paymentOperationId !== event.payload.paymentOperationId ||
        saga.paymentAmount !== event.payload.amount ||
        saga.paymentCurrency !== event.payload.currency
      ) {
        throw new Error('Refund operation does not match the Saga');
      }
      await this.completeStep(manager, saga.id, SagaStepType.PAYMENT_REFUND);
      saga.compensationStatus = CompensationStatus.PARTIALLY_COMPLETED;
      SagaTransitionValidator.assertAllowed(
        saga.currentState,
        SagaState.COMPENSATING,
      );
      saga.currentState = SagaState.COMPENSATING;
      await this.continueOrCompleteCompensation(manager, saga, event.eventId);
    });
  }

  paymentRefundFailed(event: PaymentRefundFailedEvent): Promise<void> {
    return this.process(event, async (manager) => {
      const saga = await this.lockSaga(manager, event.payload.orderId, event);
      this.assertCompensationSagaId(saga, event.payload.sagaId);
      if (
        await this.ignoreStaleCompensationResult(
          manager,
          saga,
          SagaStepType.PAYMENT_REFUND,
          event,
          event.payload.refundOperationId,
          false,
        )
      ) {
        return;
      }
      if (
        saga.currentState !== SagaState.COMPENSATION_PENDING &&
        saga.currentState !== SagaState.COMPENSATION_PARTIALLY_COMPLETED &&
        saga.currentState !== SagaState.MANUAL_INTERVENTION_REQUIRED
      ) {
        await this.handleUnexpectedState(
          manager,
          saga,
          SagaStepType.PAYMENT_REFUND,
          event,
          SagaState.COMPENSATION_PENDING,
        );
        return;
      }
      if (
        saga.paymentId !== event.payload.paymentId ||
        saga.paymentOperationId !== event.payload.paymentOperationId
      ) {
        throw new Error('Refund operation does not match the Saga');
      }
      await this.retryCompensationOrEscalate(
        manager,
        saga,
        SagaStepType.PAYMENT_REFUND,
        event.eventId,
        event.payload.reasonCode,
        event.payload.reason,
        (delayMs) =>
          this.compensation.requestPaymentRefund(
            manager,
            saga,
            event.eventId,
            delayMs,
          ),
      );
    });
  }

  paymentVoided(event: PaymentVoidedEvent): Promise<void> {
    return this.process(event, async (manager) => {
      const saga = await this.lockSaga(manager, event.payload.orderId, event);
      this.assertCompensationSagaId(saga, event.payload.sagaId);
      if (
        await this.ignoreStaleCompensationResult(
          manager,
          saga,
          SagaStepType.PAYMENT_VOID,
          event,
          event.payload.voidOperationId,
          true,
        )
      ) {
        return;
      }
      if (
        saga.currentState !== SagaState.COMPENSATION_PENDING &&
        saga.currentState !== SagaState.COMPENSATION_PARTIALLY_COMPLETED &&
        saga.currentState !== SagaState.MANUAL_INTERVENTION_REQUIRED
      ) {
        await this.handleUnexpectedState(
          manager,
          saga,
          SagaStepType.PAYMENT_VOID,
          event,
          SagaState.COMPENSATION_PENDING,
        );
        return;
      }
      if (
        saga.paymentId !== event.payload.paymentId ||
        saga.paymentOperationId !== event.payload.paymentOperationId ||
        saga.paymentAuthorizationId !== event.payload.authorizationId
      ) {
        throw new Error('Payment void result does not match the Saga');
      }
      await this.completeStep(manager, saga.id, SagaStepType.PAYMENT_VOID);
      saga.compensationStatus = CompensationStatus.PARTIALLY_COMPLETED;
      SagaTransitionValidator.assertAllowed(
        saga.currentState,
        SagaState.COMPENSATING,
      );
      saga.currentState = SagaState.COMPENSATING;
      await this.continueOrCompleteCompensation(manager, saga, event.eventId);
    });
  }

  paymentVoidFailed(event: PaymentVoidFailedEvent): Promise<void> {
    return this.process(event, async (manager) => {
      const saga = await this.lockSaga(manager, event.payload.orderId, event);
      this.assertCompensationSagaId(saga, event.payload.sagaId);
      if (
        await this.ignoreStaleCompensationResult(
          manager,
          saga,
          SagaStepType.PAYMENT_VOID,
          event,
          event.payload.voidOperationId,
          false,
        )
      ) {
        return;
      }
      if (
        saga.currentState !== SagaState.COMPENSATION_PENDING &&
        saga.currentState !== SagaState.COMPENSATION_PARTIALLY_COMPLETED &&
        saga.currentState !== SagaState.MANUAL_INTERVENTION_REQUIRED
      ) {
        await this.handleUnexpectedState(
          manager,
          saga,
          SagaStepType.PAYMENT_VOID,
          event,
          SagaState.COMPENSATION_PENDING,
        );
        return;
      }
      if (
        saga.paymentId !== event.payload.paymentId ||
        saga.paymentOperationId !== event.payload.paymentOperationId
      ) {
        throw new Error('Payment void result does not match the Saga');
      }
      const authorizationId = saga.paymentAuthorizationId;
      if (!authorizationId) {
        throw new Error(
          'Cannot retry payment void without an authorization ID',
        );
      }
      await this.retryCompensationOrEscalate(
        manager,
        saga,
        SagaStepType.PAYMENT_VOID,
        event.eventId,
        event.payload.reasonCode,
        event.payload.reason,
        (delayMs) =>
          this.compensation.requestPaymentVoid(
            manager,
            saga,
            authorizationId,
            event.eventId,
            delayMs,
          ),
      );
    });
  }

  inventoryReleased(event: InventoryReleasedEvent): Promise<void> {
    return this.process(event, async (manager) => {
      const saga = await this.lockSaga(manager, event.payload.orderId, event);
      this.assertCompensationSagaId(saga, event.payload.sagaId);
      if (
        await this.ignoreStaleCompensationResult(
          manager,
          saga,
          SagaStepType.INVENTORY_RELEASE,
          event,
          event.payload.releaseOperationId,
          true,
        )
      ) {
        return;
      }
      if (
        saga.currentState !== SagaState.COMPENSATION_PENDING &&
        saga.currentState !== SagaState.COMPENSATION_PARTIALLY_COMPLETED &&
        saga.currentState !== SagaState.MANUAL_INTERVENTION_REQUIRED
      ) {
        await this.handleUnexpectedState(
          manager,
          saga,
          SagaStepType.INVENTORY_RELEASE,
          event,
          SagaState.COMPENSATION_PENDING,
        );
        return;
      }
      if (saga.inventoryReservationId !== event.payload.reservationId) {
        throw new Error('Inventory release result does not match reservation');
      }
      this.assertReleasedItems(saga, event.payload.releasedItems);
      saga.inventoryReservationStatus = 'RELEASED';
      await this.completeStep(
        manager,
        saga.id,
        SagaStepType.INVENTORY_RELEASE,
        SagaStepStatus.COMPENSATED,
      );
      saga.compensationStatus = CompensationStatus.PARTIALLY_COMPLETED;
      await this.continueOrCompleteCompensation(manager, saga, event.eventId);
    });
  }

  inventoryReleaseFailed(event: InventoryReleaseFailedEvent): Promise<void> {
    return this.process(event, async (manager) => {
      const saga = await this.lockSaga(manager, event.payload.orderId, event);
      this.assertCompensationSagaId(saga, event.payload.sagaId);
      if (
        await this.ignoreStaleCompensationResult(
          manager,
          saga,
          SagaStepType.INVENTORY_RELEASE,
          event,
          event.payload.releaseOperationId,
          false,
        )
      ) {
        return;
      }
      if (
        saga.currentState !== SagaState.COMPENSATION_PENDING &&
        saga.currentState !== SagaState.COMPENSATION_PARTIALLY_COMPLETED &&
        saga.currentState !== SagaState.MANUAL_INTERVENTION_REQUIRED
      ) {
        await this.handleUnexpectedState(
          manager,
          saga,
          SagaStepType.INVENTORY_RELEASE,
          event,
          SagaState.COMPENSATION_PENDING,
        );
        return;
      }
      if (saga.inventoryReservationId !== event.payload.reservationId) {
        throw new Error('Inventory release result does not match reservation');
      }
      await this.retryCompensationOrEscalate(
        manager,
        saga,
        SagaStepType.INVENTORY_RELEASE,
        event.eventId,
        event.payload.reasonCode,
        event.payload.reason,
        (delayMs) =>
          this.compensation.requestInventoryRelease(
            manager,
            saga,
            event.payload.reasonCode,
            event.eventId,
            delayMs,
          ),
      );
    });
  }

  async startCompensation(
    orderId: string,
    reason: CompensationReason,
    failureReason: string,
    causationId: string,
  ): Promise<void> {
    await this.compensationOrchestrator.startCompensation(
      orderId,
      reason,
      failureReason,
      causationId,
    );
  }

  private async process<T>(
    event: SagaEvent,
    operation: (manager: EntityManager) => Promise<T>,
  ): Promise<T | undefined> {
    return this.dataSource.transaction(async (manager) => {
      try {
        await manager.getRepository(InboxEventEntity).insert({
          eventId: event.eventId,
          eventType: event.eventType,
          aggregateId: event.aggregateId,
          correlationId: event.correlationId,
          processingStatus: 'RECEIVED',
          processedAt: null,
        });
      } catch (error) {
        if (this.isDuplicateKeyError(error)) {
          const previous = await manager
            .getRepository(InboxEventEntity)
            .findOneBy({ eventId: event.eventId });
          if (
            previous?.eventType === event.eventType &&
            previous.aggregateId === event.aggregateId &&
            previous.correlationId === event.correlationId &&
            previous.processingStatus === 'PROCESSED'
          ) {
            return undefined;
          }
          throw new Error('Saga event ID was reused with different metadata');
        }
        throw error;
      }
      let result: T | undefined;
      try {
        result = await operation(manager);
      } catch (error) {
        if (!(error instanceof StaleSagaCommandEventError)) throw error;
        const saga = await this.lockSaga(manager, event.aggregateId, event);
        await this.handleUnexpectedState(
          manager,
          saga,
          error.stepType,
          event,
          saga.currentState,
          'result causation ID does not match the active command',
        );
      }
      await manager
        .getRepository(InboxEventEntity)
        .update(
          { eventId: event.eventId },
          { processingStatus: 'PROCESSED', processedAt: new Date() },
        );
      return result;
    });
  }

  private async lockSaga(
    manager: EntityManager,
    orderId: string,
    event: SagaEvent,
  ): Promise<OrderSagaEntity> {
    const saga = await manager
      .getRepository(OrderSagaEntity)
      .createQueryBuilder('saga')
      .setLock('pessimistic_write')
      .where('saga.orderId = :orderId', { orderId })
      .getOne();
    if (!saga) throw new Error(`No Saga exists for order ${orderId}`);
    if (
      saga.correlationId !== event.correlationId ||
      saga.orderId !== event.aggregateId
    ) {
      throw new Error(`Saga envelope does not match order ${orderId}`);
    }
    return saga;
  }

  private async createCommand(
    manager: EntityManager,
    saga: OrderSagaEntity,
    stepType: SagaStepType,
    eventType: string,
    payload: Record<string, string>,
    causationId: string,
  ): Promise<void> {
    const steps = manager.getRepository(SagaStepEntity);
    const step = await steps.findOneByOrFail({ sagaId: saga.id, stepType });
    const commandId = step.commandId ?? randomUUID();
    step.commandId = commandId;
    step.status = SagaStepStatus.IN_PROGRESS;
    step.attemptCount += 1;
    step.lastError = null;
    step.startedAt = new Date();
    step.deadlineAt = new Date(Date.now() + WORKFLOW_STEP_TIMEOUT_MS);
    step.completedAt = null;
    await steps.save(step);

    await this.createCommandOutboxEvent(
      manager,
      saga,
      causationId,
      commandId,
      eventType,
      payload,
    );
  }

  private async createCommandOutboxEvent(
    manager: EntityManager,
    saga: OrderSagaEntity,
    causationId: string,
    commandId: string,
    commandType: string,
    payload: Record<string, string>,
  ): Promise<void> {
    const outbox = manager.getRepository(OutboxEventEntity);
    await outbox.save(
      outbox.create({
        id: randomUUID(),
        commandId,
        aggregateType: 'Order',
        aggregateId: saga.orderId,
        eventType: commandType,
        payload: {
          commandId,
          commandType,
          eventVersion: 1,
          aggregateId: saga.orderId,
          occurredAt: new Date().toISOString(),
          correlationId: saga.correlationId,
          causationId,
          payload,
        },
        publishedAt: null,
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
      }),
    );
  }

  private async completeStep(
    manager: EntityManager,
    sagaId: string,
    stepType: SagaStepType,
    status: SagaStepStatus = SagaStepStatus.SUCCEEDED,
    errorCode: string | null = null,
  ): Promise<void> {
    const steps = manager.getRepository(SagaStepEntity);
    const step = await steps.findOneByOrFail({ sagaId, stepType });
    step.status = status;
    step.lastError = errorCode;
    step.deadlineAt = null;
    step.nextRetryAt = null;
    step.completedAt = new Date();
    await steps.save(step);
    if (
      stepType === SagaStepType.PAYMENT_VOID ||
      stepType === SagaStepType.PAYMENT_REFUND ||
      stepType === SagaStepType.INVENTORY_RELEASE
    ) {
      const saga = await manager
        .getRepository(OrderSagaEntity)
        .findOneByOrFail({
          id: sagaId,
        });
      this.logger.log(
        JSON.stringify({
          event: 'saga.compensation.step_completed',
          orderId: saga.orderId,
          sagaId,
          stepId: step.id,
          stepType,
          commandId: step.commandId,
          correlationId: saga.correlationId,
          outcome: status,
          durationMs: step.startedAt
            ? step.completedAt.getTime() - step.startedAt.getTime()
            : null,
        }),
      );
    }
  }

  private async assertCausation(
    manager: EntityManager,
    sagaId: string,
    stepType: SagaStepType,
    event: SagaEvent,
  ): Promise<void> {
    const step = await manager
      .getRepository(SagaStepEntity)
      .findOneByOrFail({ sagaId, stepType });
    if (!step.commandId || event.causationId !== step.commandId) {
      throw new StaleSagaCommandEventError(stepType);
    }
  }

  private async ignoreStaleCompensationResult(
    manager: EntityManager,
    saga: OrderSagaEntity,
    stepType: SagaStepType,
    event: SagaEvent,
    operationId: string,
    succeeded: boolean,
  ): Promise<boolean> {
    const step = await manager
      .getRepository(SagaStepEntity)
      .findOneByOrFail({ sagaId: saga.id, stepType });
    if ((step.operationId ?? step.id) !== operationId) {
      throw new Error(
        `${stepType} result does not reference its stable operation ID`,
      );
    }
    const alreadyCompleted =
      step.status === SagaStepStatus.SUCCEEDED ||
      step.status === SagaStepStatus.COMPENSATED;
    if (
      step.commandId &&
      step.commandId === event.causationId &&
      !alreadyCompleted
    ) {
      return false;
    }

    const commandType: Partial<Record<SagaStepType, string>> = {
      [SagaStepType.PAYMENT_VOID]: PAYMENT_VOID_COMMAND_TYPE,
      [SagaStepType.PAYMENT_REFUND]: PAYMENT_REFUND_COMMAND_TYPE,
      [SagaStepType.INVENTORY_RELEASE]: INVENTORY_RELEASE_COMMAND_TYPE,
    };
    const expectedCommandType = commandType[stepType];
    if (!expectedCommandType || !event.causationId) {
      throw new Error(`${stepType} result has no recognized command cause`);
    }
    const matchingCommands = (await manager.query(
      'SELECT `id` FROM `outbox_events` WHERE `aggregate_id` = ? AND `event_type` = ? AND `command_id` = ? LIMIT 1',
      [saga.orderId, expectedCommandType, event.causationId],
    )) as Array<{ id: string }>;
    if (matchingCommands.length === 0) {
      throw new Error(
        `${stepType} result does not reference a persisted compensation command`,
      );
    }

    if (alreadyCompleted || !succeeded) {
      this.logger.warn(
        JSON.stringify({
          event: 'saga.compensation.stale_result_ignored',
          orderId: saga.orderId,
          sagaId: saga.id,
          stepId: step.id,
          stepType,
          commandId: event.causationId,
          activeCommandId: step.commandId,
          correlationId: event.correlationId,
          result: succeeded ? 'succeeded' : 'failed',
        }),
      );
      return true;
    }
    return false;
  }

  private async continueOrCompleteCompensation(
    manager: EntityManager,
    saga: OrderSagaEntity,
    causationId: string,
  ): Promise<void> {
    const steps = manager.getRepository(SagaStepEntity);
    const inventoryRelease = await steps.findOneByOrFail({
      sagaId: saga.id,
      stepType: SagaStepType.INVENTORY_RELEASE,
    });
    const paymentStepType =
      saga.paymentStatus === 'CAPTURED'
        ? SagaStepType.PAYMENT_REFUND
        : saga.paymentStatus === 'AUTHORIZED'
          ? SagaStepType.PAYMENT_VOID
          : null;
    const paymentCompensation = paymentStepType
      ? await steps.findOneByOrFail({
          sagaId: saga.id,
          stepType: paymentStepType,
        })
      : null;

    if (
      saga.inventoryReservationStatus === 'RESERVED' &&
      inventoryRelease.status === SagaStepStatus.PENDING
    ) {
      await this.compensation.requestInventoryRelease(
        manager,
        saga,
        saga.failureCode ?? 'ORDER_COMPENSATION',
        causationId,
      );
      return;
    }

    const inventoryComplete =
      saga.inventoryReservationStatus !== 'RESERVED' ||
      inventoryRelease.status === SagaStepStatus.SUCCEEDED ||
      inventoryRelease.status === SagaStepStatus.COMPENSATED;
    const paymentComplete =
      !paymentCompensation ||
      paymentCompensation.status === SagaStepStatus.SUCCEEDED ||
      paymentCompensation.status === SagaStepStatus.COMPENSATED;

    if (!inventoryComplete || !paymentComplete) {
      SagaTransitionValidator.assertAllowed(
        saga.currentState,
        SagaState.COMPENSATION_PARTIALLY_COMPLETED,
      );
      saga.currentState = SagaState.COMPENSATION_PARTIALLY_COMPLETED;
      saga.compensationStatus = CompensationStatus.PARTIALLY_COMPLETED;
      await manager.getRepository(OrderSagaEntity).save(saga);
      await this.markOrderCancellationPending(
        manager,
        saga,
        causationId,
        'COMPENSATION_IN_PROGRESS',
        'Order compensation is in progress',
      );
      return;
    }

    SagaTransitionValidator.assertAllowed(
      saga.currentState,
      SagaState.COMPENSATED,
    );
    const completedAt = new Date();
    saga.currentState = SagaState.COMPENSATED;
    saga.completedAt = completedAt;
    saga.compensationStatus = CompensationStatus.COMPLETED;
    saga.compensationCompletedAt = completedAt;
    saga.compensationFailureReason = null;
    await manager.getRepository(OrderSagaEntity).save(saga);
    const order = await manager.getRepository(OrderEntity).findOneByOrFail({
      id: saga.orderId,
    });
    await OrderStatusHistoryService.transition(
      manager,
      order,
      OrderStatus.CANCELLED,
      {
        reasonCode: 'COMPENSATION_COMPLETED',
        reason: 'All required compensations completed',
        correlationId: saga.correlationId,
        causationId,
      },
    );
  }

  private assertCompensationSagaId(
    saga: OrderSagaEntity,
    resultSagaId: string,
  ): void {
    if (resultSagaId !== saga.id) {
      throw new Error('Compensation result does not match the Saga');
    }
  }

  private assertReleasedItems(
    saga: OrderSagaEntity,
    releasedItems: { productId: string; quantity: number }[],
  ): void {
    const expected = [...(saga.inventoryReservationItems ?? [])].sort(
      (left, right) => left.productId.localeCompare(right.productId),
    );
    const released = [...releasedItems].sort((left, right) =>
      left.productId.localeCompare(right.productId),
    );
    if (
      expected.length === 0 ||
      expected.length !== released.length ||
      released.some(
        (item, index) =>
          item.productId !== expected[index].productId ||
          item.quantity !== expected[index].quantity,
      )
    ) {
      throw new Error(
        'Inventory release result quantities do not match the Saga reservation',
      );
    }
  }

  private async markOrderCancellationPending(
    manager: EntityManager,
    saga: OrderSagaEntity,
    causationId: string,
    reasonCode: string,
    reason: string,
  ): Promise<void> {
    const order = await manager.getRepository(OrderEntity).findOneByOrFail({
      id: saga.orderId,
    });
    await OrderStatusHistoryService.transition(
      manager,
      order,
      OrderStatus.CANCELLATION_PENDING,
      {
        reasonCode,
        reason,
        correlationId: saga.correlationId,
        causationId,
      },
    );
  }

  private async markOrderForReconciliation(
    manager: EntityManager,
    saga: OrderSagaEntity,
    causationId: string,
    reasonCode: string,
    reason: string,
  ): Promise<void> {
    const order = await manager.getRepository(OrderEntity).findOneByOrFail({
      id: saga.orderId,
    });
    await OrderStatusHistoryService.transition(
      manager,
      order,
      OrderStatus.REQUIRES_RECONCILIATION,
      {
        reasonCode,
        reason,
        correlationId: saga.correlationId,
        causationId,
      },
    );
  }

  private async handleUnexpectedState(
    manager: EntityManager,
    saga: OrderSagaEntity,
    stepType: SagaStepType,
    event: SagaEvent,
    expectedState: SagaState,
    detail?: string,
  ): Promise<void> {
    const previousState = saga.currentState;
    const reason =
      detail ??
      `${event.eventType} arrived while Saga was ${previousState}; expected ${expectedState}`;
    if (saga.currentState !== SagaState.MANUAL_INTERVENTION_REQUIRED) {
      SagaTransitionValidator.assertAllowed(
        saga.currentState,
        SagaState.MANUAL_INTERVENTION_REQUIRED,
      );
      saga.currentState = SagaState.MANUAL_INTERVENTION_REQUIRED;
    }
    saga.failureCode = 'UNEXPECTED_SAGA_EVENT';
    saga.failureReason = reason.slice(0, 1000);
    saga.completedAt = null;
    await manager.getRepository(OrderSagaEntity).save(saga);

    const step = await manager
      .getRepository(SagaStepEntity)
      .findOneBy({ sagaId: saga.id, stepType });
    if (step) {
      step.status = SagaStepStatus.MANUAL_INTERVENTION_REQUIRED;
      step.lastError = saga.failureCode;
      step.completedAt = new Date();
      await manager.getRepository(SagaStepEntity).save(step);
    }
    await this.markOrderForReconciliation(
      manager,
      saga,
      event.eventId,
      saga.failureCode,
      'Unexpected Saga event requires manual reconciliation',
    );
    this.logOperationalAlert('saga.unexpected_result_event', {
      sagaId: saga.id,
      orderId: saga.orderId,
      eventId: event.eventId,
      eventType: event.eventType,
      currentState: previousState,
      expectedState,
    });
  }

  private async retryCompensationOrEscalate(
    manager: EntityManager,
    saga: OrderSagaEntity,
    stepType: SagaStepType,
    causationId: string,
    failureCode: string,
    failureReason: string,
    publishRetry: (delayMs: number) => Promise<void>,
  ): Promise<void> {
    const steps = manager.getRepository(SagaStepEntity);
    const step = await steps.findOneByOrFail({
      sagaId: saga.id,
      stepType,
    });
    if (step.attemptCount >= MAX_COMPENSATION_ATTEMPTS) {
      await this.requireManualIntervention(
        manager,
        saga,
        stepType,
        failureCode,
        failureReason,
      );
      return;
    }

    SagaTransitionValidator.assertAllowed(
      saga.currentState,
      SagaState.COMPENSATING,
    );
    const backoffDelayMs = Math.min(
      COMPENSATION_RETRY_BASE_DELAY_MS *
        2 ** Math.max(step.attemptCount - 1, 0),
      COMPENSATION_RETRY_MAX_DELAY_MS,
    );
    const retryDelayMs = randomInt(
      Math.max(1, Math.ceil(backoffDelayMs / 2)),
      backoffDelayMs + 1,
    );
    step.status = SagaStepStatus.PENDING;
    step.commandId = null;
    step.lastError = failureCode;
    step.completedAt = null;
    step.nextRetryAt = new Date(Date.now() + retryDelayMs);
    await steps.save(step);

    saga.currentState = SagaState.COMPENSATING;
    saga.failureCode = failureCode.slice(0, 100);
    saga.failureReason = failureReason.slice(0, 1000);
    saga.compensationStatus = CompensationStatus.IN_PROGRESS;
    saga.compensationFailureReason = failureReason.slice(0, 1000);
    await manager.getRepository(OrderSagaEntity).save(saga);
    await publishRetry(retryDelayMs);
    this.logger.warn(
      JSON.stringify({
        event: 'saga.compensation.retry_scheduled',
        sagaId: saga.id,
        orderId: saga.orderId,
        stepId: step.id,
        stepType,
        causationId,
        commandId: step.commandId,
        correlationId: saga.correlationId,
        attempt: step.attemptCount + 1,
        maxAttempts: MAX_COMPENSATION_ATTEMPTS,
        retryDelayMs,
      }),
    );
  }

  private logOperationalAlert(
    eventName: string,
    fields: Record<string, string | null>,
  ): void {
    this.logger.error(
      JSON.stringify({
        event: eventName,
        severity: 'critical',
        ...fields,
      }),
    );
  }

  private async requireManualIntervention(
    manager: EntityManager,
    saga: OrderSagaEntity,
    stepType: SagaStepType,
    failureCode: string,
    failureReason: string,
  ): Promise<void> {
    SagaTransitionValidator.assertAllowed(
      saga.currentState,
      SagaState.MANUAL_INTERVENTION_REQUIRED,
    );
    saga.currentState = SagaState.MANUAL_INTERVENTION_REQUIRED;
    saga.failureCode = failureCode.slice(0, 100);
    saga.failureReason = failureReason.slice(0, 1000);
    saga.compensationStatus = CompensationStatus.MANUAL_INTERVENTION_REQUIRED;
    saga.compensationFailureReason = failureReason.slice(0, 1000);
    await manager.getRepository(OrderSagaEntity).save(saga);
    await this.completeStep(
      manager,
      saga.id,
      stepType,
      SagaStepStatus.MANUAL_INTERVENTION_REQUIRED,
      failureCode,
    );
    const step = await manager
      .getRepository(SagaStepEntity)
      .findOneByOrFail({ sagaId: saga.id, stepType });
    const order = await manager.getRepository(OrderEntity).findOneByOrFail({
      id: saga.orderId,
    });
    await OrderStatusHistoryService.transition(
      manager,
      order,
      OrderStatus.REQUIRES_RECONCILIATION,
      {
        reasonCode: 'ORDER_REQUIRES_REVIEW',
        reason: 'Order requires manual review',
        correlationId: saga.correlationId,
        causationId: saga.compensationCausationId,
      },
    );
    this.logOperationalAlert('saga.compensation_failed', {
      sagaId: saga.id,
      orderId: saga.orderId,
      stepId: step.id,
      stepType,
      commandId: step.commandId,
      correlationId: saga.correlationId,
      failureCode,
    });
  }

  private isDuplicateKeyError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as {
      code?: unknown;
      driverError?: { code?: unknown };
    };
    return (
      candidate.code === 'ER_DUP_ENTRY' ||
      candidate.driverError?.code === 'ER_DUP_ENTRY'
    );
  }
}
