import { Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

export enum ErrorCategory {
  /** Retry with backoff — transient infrastructure issue */
  TRANSIENT = 'TRANSIENT',
  /** Retry the local transaction immediately — DB deadlock */
  DB_DEADLOCK = 'DB_DEADLOCK',
  /** Retry after a short delay — DB connection lost */
  DB_CONNECTION = 'DB_CONNECTION',
  /** Retry publishing or reconnect — RabbitMQ unavailable */
  MESSAGING = 'MESSAGING',
  /** Reconcile with provider before retrying — provider timeout */
  PROVIDER_TIMEOUT = 'PROVIDER_TIMEOUT',
  /** Do not retry — definitive business rejection */
  BUSINESS = 'BUSINESS',
  /** Dead-letter or quarantine — malformed message */
  INVALID_CONTRACT = 'INVALID_CONTRACT',
  /** Alert and suspend — misconfiguration or auth failure */
  CONFIGURATION = 'CONFIGURATION',
  /** Persist details and apply controlled recovery — unknown */
  UNKNOWN = 'UNKNOWN',
}

export interface RetryDecision {
  category: ErrorCategory;
  shouldRetry: boolean;
  /** Delay in ms before the next attempt, including jitter */
  delayMs: number;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 5;

const DB_DEADLOCK_CODES = new Set(['ER_LOCK_DEADLOCK', '40001']);
const DB_CONNECTION_CODES = new Set([
  'ER_LOCK_WAIT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ER_CON_COUNT_ERROR',
]);

@Injectable()
export class RecoveryPolicyService {
  readonly maxAttempts = MAX_ATTEMPTS;

  classify(error: unknown): ErrorCategory {
    if (error instanceof QueryFailedError) {
      const code: string = (error.driverError as { code?: string }).code ?? '';
      if (DB_DEADLOCK_CODES.has(code)) return ErrorCategory.DB_DEADLOCK;
      if (DB_CONNECTION_CODES.has(code)) return ErrorCategory.DB_CONNECTION;
      return ErrorCategory.TRANSIENT;
    }

    if (error instanceof Error) {
      const name = error.name;
      const message = error.message.toLowerCase();

      if (name === 'PaymentCommandValidationError') return ErrorCategory.INVALID_CONTRACT;
      if (name === 'PaymentOutcomeUncertainError') return ErrorCategory.PROVIDER_TIMEOUT;
      if (
        name === 'ConflictException' ||
        name === 'NotFoundException' ||
        name === 'BadRequestException'
      ) {
        return ErrorCategory.BUSINESS;
      }

      if (
        message.includes('authentication') ||
        message.includes('unauthorized') ||
        message.includes('forbidden')
      ) {
        return ErrorCategory.CONFIGURATION;
      }

      if (
        message.includes('amqp') ||
        message.includes('rabbitmq') ||
        message.includes('channel closed') ||
        message.includes('connection refused')
      ) {
        return ErrorCategory.MESSAGING;
      }

      if (message.includes('timeout') || message.includes('timed out')) {
        return ErrorCategory.PROVIDER_TIMEOUT;
      }
    }

    return ErrorCategory.UNKNOWN;
  }

  decide(error: unknown, attemptCount: number): RetryDecision {
    const category = this.classify(error);
    const exhausted = attemptCount >= this.maxAttempts;

    const noRetry = (cat: ErrorCategory): RetryDecision => ({
      category: cat,
      shouldRetry: false,
      delayMs: 0,
    });

    switch (category) {
      case ErrorCategory.BUSINESS:
      case ErrorCategory.INVALID_CONTRACT:
      case ErrorCategory.CONFIGURATION:
        return noRetry(category);

      case ErrorCategory.PROVIDER_TIMEOUT:
        // Must reconcile before retrying — caller handles reconciliation
        return noRetry(category);

      case ErrorCategory.DB_DEADLOCK:
        return {
          category,
          shouldRetry: !exhausted,
          delayMs: exhausted ? 0 : this.jitter(25 * 2 ** Math.min(attemptCount, 4)),
        };

      case ErrorCategory.DB_CONNECTION:
      case ErrorCategory.MESSAGING:
      case ErrorCategory.TRANSIENT:
      case ErrorCategory.UNKNOWN:
        return {
          category,
          shouldRetry: !exhausted,
          delayMs: exhausted ? 0 : this.backoffMs(attemptCount),
        };
    }
  }

  isExhausted(attemptCount: number): boolean {
    return attemptCount >= this.maxAttempts;
  }

  /**
   * Exponential backoff with full jitter:
   *   delay = random(0, min(MAX, BASE * 2^n))
   */
  backoffMs(attempt: number): number {
    const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempt, 16));
    return this.jitter(cap);
  }

  private jitter(cap: number): number {
    return Math.floor(Math.random() * cap);
  }
}
