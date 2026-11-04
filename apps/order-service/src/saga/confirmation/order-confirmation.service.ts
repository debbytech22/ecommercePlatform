import { Injectable, Logger } from '@nestjs/common';
import {
  ORDER_CONFIRMED_EVENT_TYPE,
  type OrderConfirmedPayload,
  type PaymentAuthorizedEvent,
} from 'default/contracts';
import { DataSource, EntityManager } from 'typeorm';
import { OrderEntity, OrderStatus } from '../../orders/entities/order.entity';
import { OrdersService } from '../../orders/orders.service';
import { OutboxEventEntity } from '../../entities/outbox-event.entity';
import { SagaState } from '../enums/saga-state.enum';
import { SagaStepStatus } from '../enums/saga-step-status.enum';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaStepEntity, SagaStepType } from '../entities/saga-step.entity';
import { SagaTransitionValidator } from '../saga-transition.validator';
import { OrderConfirmationValidator } from './order-confirmation.validator';
import type { OrderConfirmationResult } from './order-confirmation-metrics.service';
import { OrderStatusHistoryService } from '../../orders/order-status-history.service';

@Injectable()
export class OrderConfirmationService {
  private readonly logger = new Logger(OrderConfirmationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly orders: OrdersService,
    private readonly validator: OrderConfirmationValidator,
  ) {}

  async confirmOrder(
    orderId: string,
    event: PaymentAuthorizedEvent,
    transactionManager?: EntityManager,
  ): Promise<OrderConfirmationResult> {
    const confirm = (manager: EntityManager) =>
      this.confirmInTransaction(manager, orderId, event);

    if (transactionManager) {
      return confirm(transactionManager);
    }
    return this.dataSource.transaction(confirm);
  }

  private async confirmInTransaction(
    manager: EntityManager,
    orderId: string,
    event: PaymentAuthorizedEvent,
  ): Promise<OrderConfirmationResult> {
    const order: OrderEntity = await this.orders.findForUpdate(
      manager,
      orderId,
    );
    const saga = await manager.getRepository(OrderSagaEntity).findOne({
      where: { orderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!saga) {
      throw new Error(`No Saga exists for order ${orderId}`);
    }
    if (
      saga.orderId !== event.aggregateId ||
      saga.correlationId !== event.correlationId ||
      event.payload.orderId !== orderId
    ) {
      throw new Error('Payment result envelope does not match the order Saga');
    }

    const steps = manager.getRepository(SagaStepEntity);
    const inventoryStep = await steps.findOne({
      where: {
        sagaId: saga.id,
        stepType: SagaStepType.INVENTORY_RESERVATION,
      },
      lock: { mode: 'pessimistic_write' },
    });
    const paymentStep = await steps.findOne({
      where: {
        sagaId: saga.id,
        stepType: SagaStepType.PAYMENT_AUTHORIZATION,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!inventoryStep || !paymentStep) {
      throw new Error(
        `Order Saga ${saga.id} is missing required workflow steps`,
      );
    }

    const outbox = manager.getRepository(OutboxEventEntity);
    if (saga.currentState === SagaState.COMPLETED) {
      const orderItems = await this.orders.findItems(manager, orderId);
      this.validator.assertDuplicateMatches(
        order,
        saga,
        paymentStep,
        event,
        orderItems,
      );
      const persistedEvent = await outbox.findOneBy({
        id: saga.id,
        aggregateId: orderId,
        eventType: ORDER_CONFIRMED_EVENT_TYPE,
      });
      if (!persistedEvent) {
        throw new Error(
          `Completed order ${orderId} has no confirmation Outbox event`,
        );
      }
      const reservationId = saga.inventoryReservationId;
      if (!reservationId) {
        throw new Error(
          `Completed order ${orderId} has no inventory reservation`,
        );
      }
      this.logger.warn(
        JSON.stringify({
          event: 'order.confirmation.duplicate_ignored',
          orderId,
          sagaId: saga.id,
          paymentOperationId: saga.paymentOperationId,
          confirmationEventId: persistedEvent.id,
          correlationId: saga.correlationId,
        }),
      );
      return {
        outcome: 'duplicate',
        sagaId: saga.id,
        confirmationEventId: persistedEvent.id,
        inventoryReservationId: reservationId,
      };
    }

    if (
      saga.currentState !== SagaState.PAYMENT_PENDING ||
      order.status !== OrderStatus.PROCESSING_PAYMENT
    ) {
      this.logger.error(
        JSON.stringify({
          event: 'order.confirmation.invalid_state',
          orderId,
          sagaId: saga.id,
          orderStatus: order.status,
          sagaState: saga.currentState,
          paymentOperationId: event.payload.paymentOperationId,
          correlationId: event.correlationId,
        }),
      );
      throw new Error('Order is not eligible for confirmation');
    }

    const orderItems = await this.orders.findItems(manager, orderId);
    this.validator.assertEligible(
      order,
      saga,
      inventoryStep,
      paymentStep,
      event,
      orderItems,
    );

    SagaTransitionValidator.assertAllowed(
      saga.currentState,
      SagaState.PAYMENT_AUTHORIZED,
    );
    saga.currentState = SagaState.PAYMENT_AUTHORIZED;
    saga.paymentId = event.payload.paymentId;
    saga.paymentAuthorizationId = event.payload.authorizationId;
    saga.paymentAmount = event.payload.amount;
    saga.paymentCurrency = event.payload.currency;
    saga.paymentStatus = 'AUTHORIZED';
    await manager.getRepository(OrderSagaEntity).save(saga);

    paymentStep.status = SagaStepStatus.SUCCEEDED;
    paymentStep.completedAt = new Date();
    paymentStep.deadlineAt = null;
    paymentStep.lastError = null;
    await steps.save(paymentStep);

    this.validator.assertPersistedPaymentEligible(order, saga);
    SagaTransitionValidator.assertAllowed(
      saga.currentState,
      SagaState.CONFIRMATION_PENDING,
    );
    saga.currentState = SagaState.CONFIRMATION_PENDING;
    SagaTransitionValidator.assertAllowed(
      saga.currentState,
      SagaState.COMPLETED,
    );

    const confirmedAt = new Date();
    const confirmedAtIso = confirmedAt.toISOString();
    const payload: OrderConfirmedPayload = {
      orderId: order.id,
      customerId: order.customerId,
      inventoryReservationId: saga.inventoryReservationId,
      paymentId: saga.paymentId,
      paymentOperationId: saga.paymentOperationId,
      paymentStatus: saga.paymentStatus,
      amount: saga.paymentAmount,
      currency: saga.paymentCurrency,
      confirmedAt: confirmedAtIso,
    };
    await outbox.save({
      id: saga.id,
      aggregateType: 'Order',
      aggregateId: order.id,
      eventType: ORDER_CONFIRMED_EVENT_TYPE,
      payload: {
        eventId: saga.id,
        eventType: ORDER_CONFIRMED_EVENT_TYPE,
        eventVersion: 1,
        aggregateId: order.id,
        occurredAt: confirmedAtIso,
        correlationId: saga.correlationId,
        causationId: event.eventId,
        payload,
      },
      publishedAt: null,
      failedAt: null,
      attempts: 0,
      nextAttemptAt: confirmedAt,
      lastError: null,
      lockedBy: null,
      lockedUntil: null,
    });

    await OrderStatusHistoryService.transition(
      manager,
      order,
      OrderStatus.CONFIRMED,
      {
        reasonCode: 'ORDER_CONFIRMED',
        reason: 'Inventory and payment were successfully validated',
        correlationId: event.correlationId,
        causationId: event.eventId,
      },
    );
    saga.currentState = SagaState.COMPLETED;
    saga.completedAt = confirmedAt;
    await manager.getRepository(OrderSagaEntity).save(saga);
    return {
      outcome: 'confirmed',
      sagaId: saga.id,
      confirmationEventId: saga.id,
      inventoryReservationId: saga.inventoryReservationId,
    };
  }
}
