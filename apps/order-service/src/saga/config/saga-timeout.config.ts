export interface SagaTimeoutConfig {
  inventoryReservationMs: number;
  paymentAuthorizationMs: number;
  paymentCaptureMs: number;
  inventoryReleaseMs: number;
  paymentVoidMs: number;
  paymentRefundMs: number;
  confirmationMs: number;
}

const DEFAULTS: SagaTimeoutConfig = {
  inventoryReservationMs: 60_000,
  paymentAuthorizationMs: 90_000,
  paymentCaptureMs: 60_000,
  inventoryReleaseMs: 60_000,
  paymentVoidMs: 60_000,
  paymentRefundMs: 60_000,
  confirmationMs: 30_000,
};

const ENV_KEYS: Record<keyof SagaTimeoutConfig, string> = {
  inventoryReservationMs: 'SAGA_TIMEOUT_INVENTORY_RESERVATION_MS',
  paymentAuthorizationMs: 'SAGA_TIMEOUT_PAYMENT_AUTHORIZATION_MS',
  paymentCaptureMs: 'SAGA_TIMEOUT_PAYMENT_CAPTURE_MS',
  inventoryReleaseMs: 'SAGA_TIMEOUT_INVENTORY_RELEASE_MS',
  paymentVoidMs: 'SAGA_TIMEOUT_PAYMENT_VOID_MS',
  paymentRefundMs: 'SAGA_TIMEOUT_PAYMENT_REFUND_MS',
  confirmationMs: 'SAGA_TIMEOUT_CONFIRMATION_MS',
};

export function loadSagaTimeoutConfig(
  env: NodeJS.ProcessEnv,
): SagaTimeoutConfig {
  const config = {} as SagaTimeoutConfig;
  for (const key of Object.keys(DEFAULTS) as Array<keyof SagaTimeoutConfig>) {
    const envKey = ENV_KEYS[key];
    const raw = env[envKey];
    if (raw === undefined) {
      config[key] = DEFAULTS[key];
      continue;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1_000) {
      throw new Error(
        `${envKey} must be a positive integer of at least 1000 ms (got "${raw}")`,
      );
    }
    config[key] = value;
  }
  return config;
}

export const SAGA_TIMEOUT_CONFIG = Symbol('SAGA_TIMEOUT_CONFIG');
