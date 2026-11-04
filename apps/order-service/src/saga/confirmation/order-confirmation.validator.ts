import { ConflictException } from '@nestjs/common';
import type { PaymentAuthorizedEvent } from 'default/contracts';
import { OrderEntity, OrderStatus } from '../../orders/entities/order.entity';
import { OrderItemEntity } from '../../entities/order-item.entity';
import { SagaState } from '../enums/saga-state.enum';
import { SagaStepStatus } from '../enums/saga-step-status.enum';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaStepEntity, SagaStepType } from '../entities/saga-step.entity';

export const ORDER_CONFIRMATION_PAYMENT_POLICY = 'AUTHORIZED' as const;

// Order confirmation requires a successful authorization; capture remains a separate business operation.
export class OrderConfirmationValidator {
  assertEligible(
    order: OrderEntity,
    saga: OrderSagaEntity,
    inventoryStep: SagaStepEntity,
    paymentStep: SagaStepEntity,
    event: PaymentAuthorizedEvent,
    orderItems: OrderItemEntity[],
  ): void {
    if (
      saga.currentState !== SagaState.PAYMENT_PENDING ||
      order.status !== OrderStatus.PROCESSING_PAYMENT ||
      !saga.inventoryReservationId ||
      saga.inventoryReservationStatus !== 'RESERVED' ||
      !saga.inventoryReservationItems ||
      saga.paymentOperationId !== event.payload.paymentOperationId ||
      inventoryStep.stepType !== SagaStepType.INVENTORY_RESERVATION ||
      inventoryStep.status !== SagaStepStatus.SUCCEEDED ||
      paymentStep.stepType !== SagaStepType.PAYMENT_AUTHORIZATION ||
      paymentStep.status !== SagaStepStatus.IN_PROGRESS ||
      !paymentStep.commandId ||
      event.causationId !== paymentStep.commandId
    ) {
      throw new ConflictException(
        'Order is not eligible for confirmation from this payment result',
      );
    }
    if (
      event.payload.orderId !== order.id ||
      event.aggregateId !== order.id ||
      event.payload.amount !== order.totalAmount ||
      event.payload.currency !== order.currency ||
      !this.isPositiveMoney(event.payload.amount) ||
      !/^[A-Z]{3}$/.test(event.payload.currency)
    ) {
      throw new ConflictException(
        'Payment authorization does not match the persisted order total',
      );
    }
    this.assertReservationMatchesOrder(saga, orderItems);
  }

  assertDuplicateMatches(
    order: OrderEntity,
    saga: OrderSagaEntity,
    paymentStep: SagaStepEntity,
    event: PaymentAuthorizedEvent,
    orderItems: OrderItemEntity[],
  ): void {
    if (
      order.status !== OrderStatus.CONFIRMED ||
      saga.currentState !== SagaState.COMPLETED ||
      saga.paymentStatus !== ORDER_CONFIRMATION_PAYMENT_POLICY ||
      saga.inventoryReservationStatus !== 'RESERVED' ||
      !saga.inventoryReservationId ||
      saga.paymentId !== event.payload.paymentId ||
      saga.paymentOperationId !== event.payload.paymentOperationId ||
      saga.paymentAuthorizationId !== event.payload.authorizationId ||
      saga.paymentAmount !== event.payload.amount ||
      saga.paymentAmount !== order.totalAmount ||
      saga.paymentCurrency !== event.payload.currency ||
      saga.paymentCurrency !== order.currency ||
      saga.correlationId !== event.correlationId ||
      paymentStep.status !== SagaStepStatus.SUCCEEDED ||
      event.causationId !== paymentStep.commandId
    ) {
      throw new ConflictException(
        'Duplicate payment result does not match the completed order',
      );
    }
    this.assertReservationMatchesOrder(saga, orderItems);
  }

  assertPersistedPaymentEligible(
    order: OrderEntity,
    saga: OrderSagaEntity,
  ): asserts saga is OrderSagaEntity & {
    inventoryReservationId: string;
    paymentId: string;
    paymentOperationId: string;
    paymentAmount: string;
    paymentCurrency: string;
    paymentStatus: 'AUTHORIZED';
  } {
    if (
      saga.currentState !== SagaState.PAYMENT_AUTHORIZED ||
      order.status !== OrderStatus.PROCESSING_PAYMENT ||
      !saga.inventoryReservationId ||
      saga.inventoryReservationStatus !== 'RESERVED' ||
      !saga.inventoryReservationItems ||
      !saga.paymentId ||
      !saga.paymentOperationId ||
      saga.paymentStatus !== ORDER_CONFIRMATION_PAYMENT_POLICY ||
      saga.paymentAmount !== order.totalAmount ||
      saga.paymentCurrency !== order.currency
    ) {
      throw new ConflictException(
        'Persisted Saga and payment details do not satisfy confirmation policy',
      );
    }
  }

  private assertReservationMatchesOrder(
    saga: OrderSagaEntity,
    orderItems: OrderItemEntity[],
  ): void {
    const expected = [...orderItems]
      .map(({ productId, quantity }) => ({ productId, quantity }))
      .sort((left, right) => left.productId.localeCompare(right.productId));
    const reserved = [...(saga.inventoryReservationItems ?? [])].sort(
      (left, right) => left.productId.localeCompare(right.productId),
    );
    if (
      expected.length === 0 ||
      expected.length !== reserved.length ||
      reserved.some(
        (item, index) =>
          item.productId !== expected[index].productId ||
          item.quantity !== expected[index].quantity,
      )
    ) {
      throw new ConflictException(
        'Persisted inventory reservation does not match the order items',
      );
    }
  }

  private isPositiveMoney(amount: string): boolean {
    if (!/^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(amount)) return false;
    const [whole, fraction = ''] = amount.split('.');
    return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0')) > 0n;
  }
}
