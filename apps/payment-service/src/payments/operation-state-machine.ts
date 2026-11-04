import { ConflictException } from '@nestjs/common';
import { PaymentOperationStatus } from './entities/payment-operation.entity';

const transitions: Readonly<
  Record<PaymentOperationStatus, readonly PaymentOperationStatus[]>
> = {
  [PaymentOperationStatus.PENDING]: [
    PaymentOperationStatus.PROCESSING,
    PaymentOperationStatus.FAILED,
    PaymentOperationStatus.UNKNOWN,
    PaymentOperationStatus.REQUIRES_RECONCILIATION,
    PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED,
  ],
  [PaymentOperationStatus.PROCESSING]: [
    PaymentOperationStatus.PROCESSING,
    PaymentOperationStatus.SUCCEEDED,
    PaymentOperationStatus.FAILED,
    PaymentOperationStatus.UNKNOWN,
    PaymentOperationStatus.REQUIRES_RECONCILIATION,
    PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED,
  ],
  [PaymentOperationStatus.UNKNOWN]: [
    PaymentOperationStatus.PROCESSING,
    PaymentOperationStatus.SUCCEEDED,
    PaymentOperationStatus.FAILED,
    PaymentOperationStatus.REQUIRES_RECONCILIATION,
    PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED,
  ],
  [PaymentOperationStatus.REQUIRES_RECONCILIATION]: [
    PaymentOperationStatus.PROCESSING,
    PaymentOperationStatus.SUCCEEDED,
    PaymentOperationStatus.FAILED,
    PaymentOperationStatus.UNKNOWN,
    PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED,
  ],
  [PaymentOperationStatus.SUCCEEDED]: [],
  [PaymentOperationStatus.FAILED]: [
    PaymentOperationStatus.REQUIRES_RECONCILIATION,
  ],
  [PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED]: [],
};

export function assertOperationTransition(
  current: PaymentOperationStatus,
  next: PaymentOperationStatus,
): void {
  if (!transitions[current].includes(next)) {
    throw new ConflictException(
      `Payment operation transition from ${current} to ${next} is not allowed`,
    );
  }
}
