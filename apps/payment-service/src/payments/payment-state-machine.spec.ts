import { ConflictException } from '@nestjs/common';
import { PaymentOperationStatus } from './entities/payment-operation.entity';
import { PaymentStatus } from './entities/payment.entity';
import { assertOperationTransition } from './operation-state-machine';
import {
  assertCanCapture,
  assertCanRefund,
  assertPaymentTransition,
} from './payment-state-machine';

describe('Payment state transitions and amount guards', () => {
  it('allows valid authorization and capture transitions', () => {
    expect(() =>
      assertPaymentTransition(PaymentStatus.PENDING, PaymentStatus.AUTHORIZED),
    ).not.toThrow();
    expect(() =>
      assertPaymentTransition(
        PaymentStatus.AUTHORIZED,
        PaymentStatus.PARTIALLY_CAPTURED,
      ),
    ).not.toThrow();
  });

  it('rejects capturing a voided authorization', () => {
    expect(() =>
      assertCanCapture(PaymentStatus.VOIDED, '20.00', '0.00', '1.00'),
    ).toThrow(ConflictException);
  });

  it('rejects capture above the remaining authorized amount', () => {
    expect(() =>
      assertCanCapture(
        PaymentStatus.PARTIALLY_CAPTURED,
        '20.00',
        '15.00',
        '5.01',
      ),
    ).toThrow(ConflictException);
  });

  it('rejects refunds above the remaining captured amount without floats', () => {
    expect(() => assertCanRefund('10.0001', '5.0001', '5.0001')).toThrow(
      ConflictException,
    );
    expect(() => assertCanRefund('10.0001', '5.0001', '5.0000')).not.toThrow();
  });

  it('retains unknown operations as unresolved rather than declaring failure', () => {
    expect(() =>
      assertOperationTransition(
        PaymentOperationStatus.PROCESSING,
        PaymentOperationStatus.UNKNOWN,
      ),
    ).not.toThrow();
    expect(() =>
      assertOperationTransition(
        PaymentOperationStatus.UNKNOWN,
        PaymentOperationStatus.SUCCEEDED,
      ),
    ).not.toThrow();
  });

  it('rejects unsupported terminal transitions', () => {
    expect(() =>
      assertPaymentTransition(PaymentStatus.VOIDED, PaymentStatus.CAPTURED),
    ).toThrow(ConflictException);
    expect(() =>
      assertOperationTransition(
        PaymentOperationStatus.SUCCEEDED,
        PaymentOperationStatus.FAILED,
      ),
    ).toThrow(ConflictException);
  });
});
