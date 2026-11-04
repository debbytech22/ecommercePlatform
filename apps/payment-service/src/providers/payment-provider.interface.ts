export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface PaymentProviderRequest {
  operationId: string;
  idempotencyKey: string;
  orderId: string;
  amount: string;
  currency: string;
  paymentMethodReference?: string;
  providerReference?: string;
  authorizationReference?: string;
  providerTransactionReference?: string;
  timeoutMs: number;
}

export interface PaymentProviderResult {
  status: 'SUCCEEDED' | 'DECLINED' | 'PROCESSING' | 'UNKNOWN';
  providerReference: string | null;
  authorizationReference: string | null;
  failureCode: string | null;
  failureReason: string | null;
}

export interface PaymentProvider {
  authorize(request: PaymentProviderRequest): Promise<PaymentProviderResult>;
  capture(request: PaymentProviderRequest): Promise<PaymentProviderResult>;
  void(request: PaymentProviderRequest): Promise<PaymentProviderResult>;
  refund(request: PaymentProviderRequest): Promise<PaymentProviderResult>;
  getTransactionStatus(
    request: PaymentProviderRequest,
  ): Promise<PaymentProviderResult>;
}

export type PaymentProviderFailureKind =
  | 'DECLINED'
  | 'RETRYABLE'
  | 'OUTCOME_UNKNOWN'
  | 'INVALID_RESPONSE'
  | 'AUTHENTICATION';

export class PaymentProviderError extends Error {
  constructor(
    readonly kind: PaymentProviderFailureKind,
    readonly providerCode: string | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PaymentProviderError';
  }
}

export interface PaymentProviderRequestAuthenticator {
  createHeaders(
    method: string,
    path: string,
    timestamp: string,
    body: string,
  ): Promise<Readonly<Record<string, string>>>;
}

export function validatePaymentProviderRequest(
  request: PaymentProviderRequest,
): void {
  if (
    !request.operationId.trim() ||
    !request.idempotencyKey.trim() ||
    request.idempotencyKey.length > 128 ||
    !request.orderId.trim()
  ) {
    throw new TypeError('Payment provider request identifiers are invalid');
  }
  if (
    request.paymentMethodReference !== undefined &&
    (request.paymentMethodReference.trim().length === 0 ||
      request.paymentMethodReference.length > 255)
  ) {
    throw new TypeError('Payment method reference is invalid');
  }
  if (
    request.providerReference !== undefined &&
    (request.providerReference.trim().length === 0 ||
      request.providerReference.length > 255)
  ) {
    throw new TypeError('Payment provider reference is invalid');
  }
  if (
    !/^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(request.amount) ||
    !/[1-9]/.test(request.amount.replace('.', '')) ||
    !/^[A-Z]{3}$/.test(request.currency)
  ) {
    throw new TypeError(
      'Payment provider request amount or currency is invalid',
    );
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new TypeError(
      'Payment provider request timeout must be a positive integer',
    );
  }
}

export function parsePaymentProviderResult(
  value: unknown,
): PaymentProviderResult {
  if (!isRecord(value)) {
    throw new PaymentProviderError(
      'INVALID_RESPONSE',
      null,
      'Payment provider returned an invalid response',
    );
  }

  const status = value.status;
  const providerReference = value.providerReference;
  const authorizationReference = value.authorizationReference;
  const failureCode = value.failureCode;
  const failureReason = value.failureReason;

  if (
    (status !== 'SUCCEEDED' &&
      status !== 'DECLINED' &&
      status !== 'PROCESSING' &&
      status !== 'UNKNOWN') ||
    !isNullableString(providerReference) ||
    !isNullableString(authorizationReference) ||
    !isNullableString(failureCode) ||
    !isNullableString(failureReason)
  ) {
    throw new PaymentProviderError(
      'INVALID_RESPONSE',
      null,
      'Payment provider returned an invalid response',
    );
  }

  return {
    status,
    providerReference,
    authorizationReference,
    failureCode,
    failureReason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
