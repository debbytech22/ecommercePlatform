import { Injectable } from '@nestjs/common';
import type {
  PaymentAuthorizationFailedEvent,
  PaymentAuthorizationUncertainEvent,
  PaymentAuthorizedEvent,
  PaymentReconciledEvent,
  PaymentRefundFailedEvent,
  PaymentRefundedEvent,
  PaymentVoidFailedEvent,
  PaymentVoidedEvent,
} from 'default/contracts';
import {
  PAYMENT_AUTHORIZATION_UNCERTAIN_EVENT_TYPE,
  PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE,
  PAYMENT_AUTHORIZED_EVENT_TYPE,
  PAYMENT_RECONCILED_EVENT_TYPE,
  PAYMENT_REFUND_FAILED_EVENT_TYPE,
  PAYMENT_REFUNDED_EVENT_TYPE,
  PAYMENT_VOID_FAILED_EVENT_TYPE,
  PAYMENT_VOIDED_EVENT_TYPE,
} from 'default/contracts';
import { SagaOrchestratorService } from '../saga-orchestrator.service';
import { isIdentifier, isRecord, validateSagaEvent } from './event-validation';
import { UnprocessableSagaEventError } from './unprocessable-saga-event.error';

@Injectable()
export class PaymentResultConsumer {
  constructor(private readonly orchestrator: SagaOrchestratorService) {}

  async consume(event: unknown): Promise<void> {
    if (!isRecord(event) || !isRecord(event.payload)) {
      throw new UnprocessableSagaEventError('Invalid payment result event');
    }

    switch (event.eventType) {
      case PAYMENT_AUTHORIZED_EVENT_TYPE: {
        const validated = validateSagaEvent<PaymentAuthorizedEvent>(
          event,
          PAYMENT_AUTHORIZED_EVENT_TYPE,
        );
        if (
          !isIdentifier(validated.payload.paymentId) ||
          !isIdentifier(validated.payload.orderId) ||
          !isIdentifier(validated.payload.paymentOperationId) ||
          !this.isProviderReference(validated.payload.authorizationId) ||
          !this.isPositiveMoney(validated.payload.amount) ||
          !/^[A-Z]{3}$/.test(validated.payload.currency)
        ) {
          throw new UnprocessableSagaEventError(
            'Invalid payment.authorized.v1 payload',
          );
        }
        await this.orchestrator.paymentAuthorized(validated);
        return;
      }
      case PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE: {
        const validated = validateSagaEvent<PaymentAuthorizationFailedEvent>(
          event,
          PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE,
        );
        this.validatePaymentFailure(validated.payload);
        await this.orchestrator.paymentAuthorizationFailed(validated);
        return;
      }
      case PAYMENT_AUTHORIZATION_UNCERTAIN_EVENT_TYPE: {
        const validated = validateSagaEvent<PaymentAuthorizationUncertainEvent>(
          event,
          PAYMENT_AUTHORIZATION_UNCERTAIN_EVENT_TYPE,
        );
        this.validatePaymentFailure(validated.payload);
        await this.orchestrator.paymentAuthorizationUncertain(validated);
        return;
      }
      case PAYMENT_RECONCILED_EVENT_TYPE: {
        const validated = validateSagaEvent<PaymentReconciledEvent>(
          event,
          PAYMENT_RECONCILED_EVENT_TYPE,
        );
        const payload = validated.payload;
        if (
          !isIdentifier(payload.orderId) ||
          !isIdentifier(payload.paymentOperationId) ||
          !isIdentifier(payload.reconciliationCommandId) ||
          ![
            'AUTHORIZED',
            'NOT_AUTHORIZED',
            'CAPTURED',
            'PENDING',
            'UNKNOWN',
          ].includes(payload.status) ||
          (payload.authorizationId !== null &&
            !isIdentifier(payload.authorizationId)) ||
          (payload.reasonCode !== null &&
            !/^[A-Z0-9_]{1,100}$/.test(payload.reasonCode)) ||
          (payload.reason !== null &&
            (typeof payload.reason !== 'string' ||
              payload.reason.length > 1000))
        ) {
          throw new UnprocessableSagaEventError(
            'Invalid payment.reconciled.v1 payload',
          );
        }
        await this.orchestrator.paymentReconciled(validated);
        return;
      }
      case PAYMENT_REFUNDED_EVENT_TYPE: {
        const validated = validateSagaEvent<PaymentRefundedEvent>(
          event,
          PAYMENT_REFUNDED_EVENT_TYPE,
        );
        if (
          !isIdentifier(validated.payload.orderId) ||
          !isIdentifier(validated.payload.sagaId) ||
          !isIdentifier(validated.payload.paymentOperationId) ||
          !isIdentifier(validated.payload.refundOperationId) ||
          !this.isProviderReference(validated.payload.refundId) ||
          !this.isPositiveMoney(validated.payload.amount) ||
          !/^[A-Z]{3}$/.test(validated.payload.currency)
        ) {
          throw new UnprocessableSagaEventError(
            'Invalid payment.refunded.v1 payload',
          );
        }
        await this.orchestrator.paymentRefunded(validated);
        return;
      }
      case PAYMENT_REFUND_FAILED_EVENT_TYPE: {
        const validated = validateSagaEvent<PaymentRefundFailedEvent>(
          event,
          PAYMENT_REFUND_FAILED_EVENT_TYPE,
        );
        if (
          !isIdentifier(validated.payload.sagaId) ||
          !isIdentifier(validated.payload.refundOperationId)
        ) {
          throw new UnprocessableSagaEventError(
            'Invalid payment.refund_failed.v1 payload',
          );
        }
        this.validatePaymentFailure(validated.payload);
        await this.orchestrator.paymentRefundFailed(validated);
        return;
      }
      case PAYMENT_VOIDED_EVENT_TYPE: {
        const validated = validateSagaEvent<PaymentVoidedEvent>(
          event,
          PAYMENT_VOIDED_EVENT_TYPE,
        );
        if (
          !isIdentifier(validated.payload.orderId) ||
          !isIdentifier(validated.payload.sagaId) ||
          !isIdentifier(validated.payload.paymentOperationId) ||
          !isIdentifier(validated.payload.voidOperationId) ||
          !this.isProviderReference(validated.payload.authorizationId)
        ) {
          throw new UnprocessableSagaEventError(
            'Invalid payment.voided.v1 payload',
          );
        }
        await this.orchestrator.paymentVoided(validated);
        return;
      }
      case PAYMENT_VOID_FAILED_EVENT_TYPE: {
        const validated = validateSagaEvent<PaymentVoidFailedEvent>(
          event,
          PAYMENT_VOID_FAILED_EVENT_TYPE,
        );
        if (
          !isIdentifier(validated.payload.sagaId) ||
          !isIdentifier(validated.payload.voidOperationId)
        ) {
          throw new UnprocessableSagaEventError(
            'Invalid payment.void_failed.v1 payload',
          );
        }
        this.validatePaymentFailure(validated.payload);
        await this.orchestrator.paymentVoidFailed(validated);
        return;
      }
      default:
        throw new UnprocessableSagaEventError(
          'Unsupported payment result event type',
        );
    }
  }

  private validatePaymentFailure(payload: {
    orderId: string;
    sagaId: string;
    paymentOperationId: string;
    reasonCode: string;
    reason: string;
  }): void {
    if (
      !isIdentifier(payload.orderId) ||
      !isIdentifier(payload.sagaId) ||
      !isIdentifier(payload.paymentOperationId) ||
      !/^[A-Z0-9_]{1,100}$/.test(payload.reasonCode) ||
      typeof payload.reason !== 'string' ||
      payload.reason.length > 1000
    ) {
      throw new UnprocessableSagaEventError('Invalid payment failure payload');
    }
  }

  private isPositiveMoney(amount: string): boolean {
    if (!/^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(amount)) return false;
    const [whole, fraction = ''] = amount.split('.');
    return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0')) > 0n;
  }

  private isProviderReference(value: string): boolean {
    return (
      typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= 128
    );
  }
}
