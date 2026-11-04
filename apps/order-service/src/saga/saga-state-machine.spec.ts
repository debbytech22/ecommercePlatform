import { SagaState } from './enums/saga-state.enum';
import { canTransitionSaga } from './saga-state-machine';

describe('Order Saga state machine', () => {
  it.each([
    [SagaState.PENDING, SagaState.INVENTORY_RESERVATION_PENDING],
    [SagaState.INVENTORY_RESERVATION_PENDING, SagaState.INVENTORY_RESERVED],
    [SagaState.INVENTORY_RESERVED, SagaState.PAYMENT_PENDING],
    [SagaState.PAYMENT_PENDING, SagaState.PAYMENT_AUTHORIZED],
    [SagaState.PAYMENT_AUTHORIZED, SagaState.CONFIRMATION_PENDING],
    [SagaState.CONFIRMATION_PENDING, SagaState.COMPLETED],
    [SagaState.PAYMENT_PENDING, SagaState.COMPENSATING],
    [SagaState.COMPLETED, SagaState.COMPENSATING],
    [SagaState.COMPENSATED, SagaState.COMPENSATING],
    [SagaState.COMPENSATING, SagaState.COMPENSATED],
    [SagaState.COMPENSATING, SagaState.COMPENSATION_PENDING],
    [SagaState.COMPENSATION_PENDING, SagaState.COMPENSATED],
    [SagaState.COMPENSATION_PENDING, SagaState.MANUAL_INTERVENTION_REQUIRED],
    [SagaState.INVENTORY_RESERVATION_PENDING, SagaState.FAILED],
    [SagaState.COMPLETED, SagaState.MANUAL_INTERVENTION_REQUIRED],
    [SagaState.COMPENSATED, SagaState.MANUAL_INTERVENTION_REQUIRED],
    [SagaState.FAILED, SagaState.MANUAL_INTERVENTION_REQUIRED],
    [
      SagaState.MANUAL_INTERVENTION_REQUIRED,
      SagaState.COMPENSATION_PARTIALLY_COMPLETED,
    ],
  ])('allows %s -> %s', (current, next) => {
    expect(canTransitionSaga(current, next)).toBe(true);
  });

  it.each([
    [SagaState.COMPENSATED, SagaState.PAYMENT_PENDING],
    [SagaState.FAILED, SagaState.INVENTORY_RESERVED],
    [SagaState.INVENTORY_RESERVATION_PENDING, SagaState.COMPLETED],
    [SagaState.PAYMENT_PENDING, SagaState.CONFIRMATION_PENDING],
  ])('rejects %s -> %s', (current, next) => {
    expect(canTransitionSaga(current, next)).toBe(false);
  });
});
