import { ConflictException } from '@nestjs/common';
import { PaymentStatus } from './entities/payment.entity';

const transitions: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  [PaymentStatus.PENDING]: [
    PaymentStatus.AUTHORIZED,
    PaymentStatus.FAILED,
    PaymentStatus.REQUIRES_RECONCILIATION,
  ],
  [PaymentStatus.AUTHORIZED]: [
    PaymentStatus.PARTIALLY_CAPTURED,
    PaymentStatus.CAPTURED,
    PaymentStatus.VOIDED,
    PaymentStatus.REQUIRES_RECONCILIATION,
  ],
  [PaymentStatus.PARTIALLY_CAPTURED]: [
    PaymentStatus.PARTIALLY_CAPTURED,
    PaymentStatus.CAPTURED,
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
    PaymentStatus.REQUIRES_RECONCILIATION,
  ],
  [PaymentStatus.CAPTURED]: [
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
    PaymentStatus.REQUIRES_RECONCILIATION,
  ],
  [PaymentStatus.PARTIALLY_REFUNDED]: [
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
    PaymentStatus.REQUIRES_RECONCILIATION,
  ],
  [PaymentStatus.REFUNDED]: [PaymentStatus.REQUIRES_RECONCILIATION],
  [PaymentStatus.VOIDED]: [PaymentStatus.REQUIRES_RECONCILIATION],
  [PaymentStatus.FAILED]: [
    PaymentStatus.AUTHORIZED,
    PaymentStatus.FAILED,
    PaymentStatus.REQUIRES_RECONCILIATION,
  ],
  [PaymentStatus.REQUIRES_RECONCILIATION]: [
    PaymentStatus.PENDING,
    PaymentStatus.AUTHORIZED,
    PaymentStatus.PARTIALLY_CAPTURED,
    PaymentStatus.CAPTURED,
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
    PaymentStatus.VOIDED,
    PaymentStatus.FAILED,
  ],
};

export function assertPaymentTransition(
  current: PaymentStatus,
  next: PaymentStatus,
): void {
  if (!transitions[current].includes(next)) {
    throw new ConflictException(
      `Payment transition from ${current} to ${next} is not allowed`,
    );
  }
}

export function toMinorUnits(value: string): bigint {
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(value)
  ) {
    throw new ConflictException(
      'Payment amount must be a positive decimal with at most four fractional digits',
    );
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
}

export function assertPositivePaymentAmount(amount: string): bigint {
  const minorUnits = toMinorUnits(amount);
  if (minorUnits <= 0n) {
    throw new ConflictException('Payment amount must be greater than zero');
  }
  return minorUnits;
}

export function assertCanCapture(
  status: PaymentStatus,
  authorizedAmount: string,
  capturedAmount: string,
  requestedAmount: string,
): void {
  if (
    status !== PaymentStatus.AUTHORIZED &&
    status !== PaymentStatus.PARTIALLY_CAPTURED
  ) {
    throw new ConflictException(
      `Payment in ${status} state cannot be captured`,
    );
  }
  const authorized = assertPositivePaymentAmount(authorizedAmount);
  const captured = toMinorUnits(capturedAmount);
  const requested = assertPositivePaymentAmount(requestedAmount);
  if (captured + requested > authorized) {
    throw new ConflictException(
      'Capture amount exceeds the remaining authorized amount',
    );
  }
}

export function assertCanRefund(
  capturedAmount: string,
  alreadyRefundedAmount: string,
  requestedAmount: string,
): void {
  const captured = toMinorUnits(capturedAmount);
  const refunded = toMinorUnits(alreadyRefundedAmount);
  const requested = assertPositivePaymentAmount(requestedAmount);
  if (refunded + requested > captured) {
    throw new ConflictException(
      'Refund amount exceeds the remaining captured amount',
    );
  }
}
