export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface VersionedEventEnvelope {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  payload: Record<string, unknown>;
}

export interface VersionedCommandEnvelope {
  commandId: string;
  commandType: string;
  eventVersion: number;
  occurredAt: string;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  payload: Record<string, unknown>;
}

export type VersionedMessageEnvelope =
  VersionedEventEnvelope | VersionedCommandEnvelope;

export interface OutboxPublisher {
  publish(event: OutboxEvent): Promise<void>;
}
