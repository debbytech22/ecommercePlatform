import { InventoryMetricsService } from './inventory-metrics.service';

describe('InventoryMetricsService', () => {
  it('renders consumer outcomes and processing latency as Prometheus metrics', () => {
    const metrics = new InventoryMetricsService();
    metrics.recordConsumerOutcome('processed');
    metrics.recordConsumerOutcome('duplicate');
    metrics.recordConsumerOutcome('retried');
    metrics.recordConsumerDuration(0.03);
    metrics.recordConsumerDuration(2);

    const output = metrics.renderPrometheus();

    expect(output).toContain(
      'inventory_consumer_events_total{outcome="processed"} 1',
    );
    expect(output).toContain(
      'inventory_consumer_events_total{outcome="duplicate"} 1',
    );
    expect(output).toContain(
      'inventory_consumer_events_total{outcome="retried"} 1',
    );
    expect(output).toContain(
      'inventory_reservation_processing_seconds_bucket{le="0.05"} 1',
    );
    expect(output).toContain(
      'inventory_reservation_processing_seconds_count 2',
    );
  });
});
