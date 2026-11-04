import { Injectable } from '@nestjs/common';

export type InventoryConsumerOutcome =
  'processed' | 'duplicate' | 'failed' | 'retried' | 'dead_lettered';

const HISTOGRAM_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30];
const OUTCOMES: InventoryConsumerOutcome[] = [
  'processed',
  'duplicate',
  'failed',
  'retried',
  'dead_lettered',
];
const RABBITMQ_COMPONENTS = ['consumer', 'publisher'] as const;
type RabbitMqComponent = (typeof RABBITMQ_COMPONENTS)[number];

@Injectable()
export class InventoryMetricsService {
  private readonly consumerOutcomes = new Map<InventoryConsumerOutcome, number>(
    OUTCOMES.map((outcome) => [outcome, 0]),
  );
  private consumerDurationCount = 0;
  private consumerDurationSumSeconds = 0;
  private readonly consumerDurationBuckets = new Map<number, number>(
    HISTOGRAM_BUCKETS.map((bucket) => [bucket, 0]),
  );
  private readonly rabbitMqConnections = new Map<RabbitMqComponent, number>(
    RABBITMQ_COMPONENTS.map((component) => [component, 0]),
  );
  private readonly rabbitMqReconnects = new Map<RabbitMqComponent, number>(
    RABBITMQ_COMPONENTS.map((component) => [component, 0]),
  );

  recordConsumerOutcome(outcome: InventoryConsumerOutcome): void {
    this.consumerOutcomes.set(
      outcome,
      (this.consumerOutcomes.get(outcome) ?? 0) + 1,
    );
  }

  recordConsumerDuration(durationSeconds: number): void {
    this.consumerDurationCount += 1;
    this.consumerDurationSumSeconds += durationSeconds;
    for (const bucket of HISTOGRAM_BUCKETS) {
      if (durationSeconds <= bucket) {
        this.consumerDurationBuckets.set(
          bucket,
          (this.consumerDurationBuckets.get(bucket) ?? 0) + 1,
        );
      }
    }
  }

  setRabbitMqConnected(component: RabbitMqComponent, connected: boolean): void {
    this.rabbitMqConnections.set(component, connected ? 1 : 0);
  }

  recordRabbitMqReconnect(component: RabbitMqComponent): void {
    this.rabbitMqReconnects.set(
      component,
      (this.rabbitMqReconnects.get(component) ?? 0) + 1,
    );
  }

  renderPrometheus(): string {
    const lines = [
      '# HELP inventory_consumer_events_total Consumer processing outcomes since process start.',
      '# TYPE inventory_consumer_events_total counter',
      ...OUTCOMES.map(
        (outcome) =>
          `inventory_consumer_events_total{outcome="${outcome}"} ${this.consumerOutcomes.get(outcome) ?? 0}`,
      ),
      '# HELP inventory_reservation_processing_seconds OrderCreated inbox and reservation processing latency.',
      '# TYPE inventory_reservation_processing_seconds histogram',
      ...HISTOGRAM_BUCKETS.map(
        (bucket) =>
          `inventory_reservation_processing_seconds_bucket{le="${bucket}"} ${this.consumerDurationBuckets.get(bucket) ?? 0}`,
      ),
      `inventory_reservation_processing_seconds_bucket{le="+Inf"} ${this.consumerDurationCount}`,
      `inventory_reservation_processing_seconds_sum ${this.consumerDurationSumSeconds}`,
      `inventory_reservation_processing_seconds_count ${this.consumerDurationCount}`,
      '# HELP inventory_rabbitmq_connected Whether the Inventory RabbitMQ component is connected.',
      '# TYPE inventory_rabbitmq_connected gauge',
      ...RABBITMQ_COMPONENTS.map(
        (component) =>
          `inventory_rabbitmq_connected{component="${component}"} ${this.rabbitMqConnections.get(component) ?? 0}`,
      ),
      '# HELP inventory_rabbitmq_reconnects_total RabbitMQ connection attempts since process start.',
      '# TYPE inventory_rabbitmq_reconnects_total counter',
      ...RABBITMQ_COMPONENTS.map(
        (component) =>
          `inventory_rabbitmq_reconnects_total{component="${component}"} ${this.rabbitMqReconnects.get(component) ?? 0}`,
      ),
    ];
    return lines.join('\n');
  }
}
