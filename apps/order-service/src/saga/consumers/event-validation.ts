import type { EventEnvelope } from 'default/contracts';
import { UnprocessableSagaEventError } from './unprocessable-saga-event.error';

export function validateSagaEvent<T extends EventEnvelope<string, object>>(
  value: unknown,
  expectedType: T['eventType'],
): T {
  if (!isRecord(value) || !isRecord(value.payload)) {
    throw new UnprocessableSagaEventError('Invalid Saga event envelope');
  }
  if (
    value.eventType !== expectedType ||
    value.eventVersion !== 1 ||
    !isIdentifier(value.eventId) ||
    !isIdentifier(value.aggregateId) ||
    !isIdentifier(value.correlationId) ||
    (value.causationId !== null && !isIdentifier(value.causationId)) ||
    typeof value.occurredAt !== 'string' ||
    Number.isNaN(Date.parse(value.occurredAt))
  ) {
    throw new UnprocessableSagaEventError(
      `Invalid ${expectedType} event envelope`,
    );
  }
  if (value.payload.orderId !== value.aggregateId) {
    throw new UnprocessableSagaEventError(
      `${expectedType} aggregate ID does not match its order ID`,
    );
  }
  return value as T;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= 36
  );
}
