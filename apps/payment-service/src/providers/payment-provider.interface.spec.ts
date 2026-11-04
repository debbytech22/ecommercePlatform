import { PaymentProviderError } from './payment-provider.interface';
import {
  parsePaymentProviderResult,
  validatePaymentProviderRequest,
} from './payment-provider.interface';
import type { PaymentProviderRequest } from './payment-provider.interface';

const request: PaymentProviderRequest = {
  operationId: 'operation-1',
  idempotencyKey: 'operation-1',
  orderId: 'order-1',
  amount: '25.0000',
  currency: 'USD',
  timeoutMs: 5000,
};

describe('Payment provider contract validation', () => {
  it('accepts a valid idempotent request', () => {
    expect(() => validatePaymentProviderRequest(request)).not.toThrow();
  });

  it.each(['0', '-1.00', '01.00', '1.00001'])(
    'rejects invalid provider amount %s',
    (amount) => {
      expect(() =>
        validatePaymentProviderRequest({ ...request, amount }),
      ).toThrow(TypeError);
    },
  );

  it('rejects invalid timeout and currency values', () => {
    expect(() =>
      validatePaymentProviderRequest({ ...request, timeoutMs: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      validatePaymentProviderRequest({ ...request, currency: 'usd' }),
    ).toThrow(TypeError);
  });

  it('parses a normalized provider result', () => {
    expect(
      parsePaymentProviderResult({
        status: 'UNKNOWN',
        providerReference: null,
        authorizationReference: null,
        failureCode: null,
        failureReason: null,
      }),
    ).toEqual({
      status: 'UNKNOWN',
      providerReference: null,
      authorizationReference: null,
      failureCode: null,
      failureReason: null,
    });
  });

  it('rejects malformed or incomplete provider results', () => {
    expect(() => parsePaymentProviderResult({ status: 'SUCCEEDED' })).toThrow(
      PaymentProviderError,
    );
    expect(() =>
      parsePaymentProviderResult({
        status: 'FAILED',
        providerReference: null,
        authorizationReference: null,
        failureCode: null,
        failureReason: null,
      }),
    ).toThrow(PaymentProviderError);
  });
});
