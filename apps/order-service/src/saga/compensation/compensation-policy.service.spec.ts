import { SagaState } from '../enums/saga-state.enum';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaStepType } from '../entities/saga-step.entity';
import { SagaStepStatus } from '../enums/saga-step-status.enum';
import { CompensationPolicyService } from './compensation-policy.service';
import { CompensationReason } from './compensation.types';

describe('CompensationPolicyService', () => {
  const service = new CompensationPolicyService();
  const saga = {
    id: 'saga-1',
    currentState: SagaState.COMPLETED,
    paymentOperationId: 'payment-operation-1',
    paymentAuthorizationId: 'authorization-1',
    paymentStatus: 'AUTHORIZED',
    inventoryReservationId: 'reservation-1',
    inventoryReservationStatus: 'RESERVED',
  } as OrderSagaEntity;

  it('voids successful authorization before inventory release', () => {
    expect(
      service.determineCompensations(
        saga,
        CompensationReason.ORDER_CANCELLATION,
      ),
    ).toEqual(['VOID_AUTHORIZATION', 'RELEASE_INVENTORY']);
  });

  it('refunds captured payments', () => {
    expect(
      service.determineCompensations(
        {
          ...saga,
          paymentStatus: 'CAPTURED',
        } as OrderSagaEntity,
        CompensationReason.ORDER_CANCELLATION,
      ),
    ).toEqual(['REFUND_CAPTURE', 'RELEASE_INVENTORY']);
  });

  it('releases inventory if no payment operation was started', () => {
    expect(
      service.determineCompensations(
        {
          ...saga,
          paymentOperationId: null,
          paymentAuthorizationId: null,
          paymentStatus: null,
        } as OrderSagaEntity,
        CompensationReason.PAYMENT_AUTHORIZATION_FAILED,
      ),
    ).toEqual(['RELEASE_INVENTORY']);
  });

  it('reconciles an unknown payment before releasing inventory', () => {
    expect(
      service.determineCompensations(
        {
          ...saga,
          paymentOperationId: 'payment-operation-1',
          paymentAuthorizationId: null,
          paymentStatus: null,
        } as OrderSagaEntity,
        CompensationReason.ORDER_CANCELLATION,
      ),
    ).toEqual(['RECONCILE_PAYMENT']);
  });

  it('does not release inventory while payment void is still in progress', () => {
    expect(
      service.determineCompensations(
        saga,
        CompensationReason.ORDER_CANCELLATION,
        [
          {
            stepType: SagaStepType.PAYMENT_VOID,
            status: SagaStepStatus.IN_PROGRESS,
          },
        ],
      ),
    ).toEqual([]);
  });

  it('releases inventory after a successful void', () => {
    expect(
      service.determineCompensations(
        saga,
        CompensationReason.ORDER_CANCELLATION,
        [
          {
            stepType: SagaStepType.PAYMENT_VOID,
            status: SagaStepStatus.SUCCEEDED,
          },
        ],
      ),
    ).toEqual(['RELEASE_INVENTORY']);
  });

  it('requires no compensation when inventory reservation itself failed', () => {
    expect(
      service.determineCompensations(
        saga,
        CompensationReason.INVENTORY_RESERVATION_FAILED,
      ),
    ).toEqual([]);
  });

  it('does not create payment compensation after a definitive authorization failure', () => {
    expect(
      service.determineCompensations(
        {
          ...saga,
          paymentAuthorizationId: null,
          paymentStatus: null,
        } as OrderSagaEntity,
        CompensationReason.PAYMENT_AUTHORIZATION_FAILED,
      ),
    ).toEqual(['RELEASE_INVENTORY']);
  });
});
