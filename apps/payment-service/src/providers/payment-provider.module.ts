import { Module } from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  PaymentProviderError,
} from './payment-provider.interface';

class UnconfiguredPaymentProvider {
  async authorize(): Promise<never> {
    throw this.unavailable();
  }

  async capture(): Promise<never> {
    throw this.unavailable();
  }

  async void(): Promise<never> {
    throw this.unavailable();
  }

  async refund(): Promise<never> {
    throw this.unavailable();
  }

  async getTransactionStatus(): Promise<never> {
    throw this.unavailable();
  }

  private unavailable(): PaymentProviderError {
    return new PaymentProviderError(
      'RETRYABLE',
      'PROVIDER_NOT_CONFIGURED',
      'No payment provider adapter has been configured',
    );
  }
}

@Module({
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      useClass: UnconfiguredPaymentProvider,
    },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentProviderModule {}
