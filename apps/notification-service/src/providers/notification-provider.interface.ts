// ── Shared error ─────────────────────────────────────────────────────────────

export type ProviderErrorKind =
  | 'INVALID_ADDRESS'   // permanent — bad email / phone
  | 'RATE_LIMITED'      // retryable — provider throttle
  | 'PROVIDER_ERROR'    // retryable — transient provider fault
  | 'AUTHENTICATION'    // permanent — misconfigured credentials
  | 'REJECTED'          // permanent — provider rejected the content/recipient
  | 'TIMEOUT';          // uncertain — may have been accepted; reconcile before retry

export class NotificationProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: ProviderErrorKind,
    public readonly retryable: boolean,
    /** Milliseconds to wait before retrying (from Retry-After header, etc.) */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'NotificationProviderError';
  }
}

// ── Email ─────────────────────────────────────────────────────────────────────

export interface SendEmailRequest {
  notificationId: string;
  idempotencyKey: string;
  to: string;
  subject: string;
  body: string;
}

export interface SendEmailResult {
  providerMessageId: string | null;
  providerName: string;
}

export interface EmailProvider {
  sendEmail(request: SendEmailRequest): Promise<SendEmailResult>;
}

// ── SMS ───────────────────────────────────────────────────────────────────────

export interface SendSmsRequest {
  notificationId: string;
  idempotencyKey: string;
  to: string;
  body: string;
}

export interface SendSmsResult {
  providerMessageId: string | null;
  providerName: string;
}

export interface SmsProvider {
  sendSms(request: SendSmsRequest): Promise<SendSmsResult>;
}

// ── Push ──────────────────────────────────────────────────────────────────────

export interface SendPushRequest {
  notificationId: string;
  idempotencyKey: string;
  deviceToken: string;
  title: string;
  body: string;
}

export interface SendPushResult {
  providerMessageId: string | null;
  providerName: string;
}

export interface PushProvider {
  sendPush(request: SendPushRequest): Promise<SendPushResult>;
}

// ── Injection tokens ──────────────────────────────────────────────────────────

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');
