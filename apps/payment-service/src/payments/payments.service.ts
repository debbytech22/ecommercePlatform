import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentEntity, PaymentStatus } from './entities/payment.entity';
import { PaymentOperationStatus } from './entities/payment-operation.entity';
import {
  assertCanCapture,
  assertCanRefund,
  assertPaymentTransition,
  assertPositivePaymentAmount,
} from './payment-state-machine';
import { assertOperationTransition } from './operation-state-machine';
import { PaymentsRepository } from './payments.repository';

@Injectable()
export class PaymentsService {
  constructor(private readonly payments: PaymentsRepository) {}

  validatePaymentInitialization(amount: string, currency: string): void {
    assertPositivePaymentAmount(amount);
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException(
        'Currency must be an uppercase ISO 4217 code',
      );
    }
  }

  assertPaymentTransition(current: PaymentStatus, next: PaymentStatus): void {
    assertPaymentTransition(current, next);
  }

  assertOperationTransition(
    current: PaymentOperationStatus,
    next: PaymentOperationStatus,
  ): void {
    assertOperationTransition(current, next);
  }

  validateCapture(payment: PaymentEntity, amount: string): void {
    assertCanCapture(
      payment.status,
      payment.authorizedAmount,
      payment.capturedAmount,
      amount,
    );
  }

  validateRefund(payment: PaymentEntity, amount: string): void {
    assertCanRefund(payment.capturedAmount, payment.refundedAmount, amount);
  }
}
