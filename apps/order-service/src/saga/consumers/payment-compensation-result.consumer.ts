import { Injectable } from '@nestjs/common';
import {
  PAYMENT_REFUND_FAILED_EVENT_TYPE,
  PAYMENT_REFUNDED_EVENT_TYPE,
  PAYMENT_VOID_FAILED_EVENT_TYPE,
  PAYMENT_VOIDED_EVENT_TYPE,
} from 'default/contracts';
import { PaymentResultConsumer } from './payment-result.consumer';
import { UnprocessableSagaEventError } from './unprocessable-saga-event.error';

const compensationEventTypes = new Set<string>([
  PAYMENT_REFUND_FAILED_EVENT_TYPE,
  PAYMENT_REFUNDED_EVENT_TYPE,
  PAYMENT_VOID_FAILED_EVENT_TYPE,
  PAYMENT_VOIDED_EVENT_TYPE,
]);

@Injectable()
export class PaymentCompensationResultConsumer {
  constructor(private readonly paymentResults: PaymentResultConsumer) {}

  consume(event: unknown): Promise<void> {
    if (
      typeof event !== 'object' ||
      event === null ||
      !('eventType' in event) ||
      typeof event.eventType !== 'string' ||
      !compensationEventTypes.has(event.eventType)
    ) {
      throw new UnprocessableSagaEventError(
        'Unsupported payment compensation result event',
      );
    }
    return this.paymentResults.consume(event);
  }
}
