import { ConflictException, Injectable } from '@nestjs/common';
import { SagaState } from '../enums/saga-state.enum';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaTransitionValidator } from '../saga-transition.validator';

@Injectable()
export class CompensationStateValidator {
  assertCanStart(saga: OrderSagaEntity): void {
    if (
      saga.currentState !== SagaState.PAYMENT_AUTHORIZED &&
      saga.currentState !== SagaState.PAYMENT_PENDING &&
      saga.currentState !== SagaState.INVENTORY_RESERVED &&
      saga.currentState !== SagaState.CONFIRMATION_PENDING &&
      saga.currentState !== SagaState.COMPENSATION_REQUIRED &&
      saga.currentState !== SagaState.COMPLETED
    ) {
      throw new ConflictException(
        `Saga ${saga.id} cannot start compensation from ${saga.currentState}`,
      );
    }
    SagaTransitionValidator.assertAllowed(
      saga.currentState,
      SagaState.COMPENSATING,
    );
  }

  assertSameRequest(
    saga: OrderSagaEntity,
    failureCode: string,
    causationId: string,
  ): void {
    if (
      saga.failureCode !== failureCode ||
      saga.compensationCausationId !== causationId
    ) {
      throw new ConflictException(
        `Saga ${saga.id} is already compensating for a different request`,
      );
    }
  }
}
