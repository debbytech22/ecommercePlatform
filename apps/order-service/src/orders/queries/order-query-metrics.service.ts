import { Injectable } from '@nestjs/common';

export type OrderQueryOperation = 'get' | 'list' | 'status' | 'timeline';
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 3];

@Injectable()
export class OrderQueryMetricsService {
  private readonly requests = new Map<OrderQueryOperation, number>();
  private readonly errors = new Map<OrderQueryOperation, number>();
  private readonly durations = new Map<
    OrderQueryOperation,
    { count: number; sumSeconds: number; buckets: number[] }
  >();
  private notFound = 0;

  recordSuccess(operation: OrderQueryOperation, durationMs: number): void {
    this.requests.set(operation, (this.requests.get(operation) ?? 0) + 1);
    const duration = this.durations.get(operation) ?? {
      count: 0,
      sumSeconds: 0,
      buckets: DURATION_BUCKETS.map(() => 0),
    };
    duration.count += 1;
    const durationSeconds = durationMs / 1000;
    duration.sumSeconds += durationSeconds;
    DURATION_BUCKETS.forEach((bucket, index) => {
      if (durationSeconds <= bucket) duration.buckets[index] += 1;
    });
    this.durations.set(operation, duration);
  }

  recordError(
    operation: OrderQueryOperation,
    durationMs: number,
    notFound = false,
  ): void {
    this.recordSuccess(operation, durationMs);
    this.errors.set(operation, (this.errors.get(operation) ?? 0) + 1);
    if (notFound) this.notFound += 1;
  }

  renderPrometheus(): string {
    const operations: OrderQueryOperation[] = [
      'get',
      'list',
      'status',
      'timeline',
    ];
    return [
      '# HELP order_service_query_requests_total Order Service query requests by operation.',
      '# TYPE order_service_query_requests_total counter',
      ...operations.map(
        (operation) =>
          `order_service_query_requests_total{operation="${operation}"} ${this.requests.get(operation) ?? 0}`,
      ),
      '# HELP order_service_query_errors_total Order Service query failures by operation.',
      '# TYPE order_service_query_errors_total counter',
      ...operations.map(
        (operation) =>
          `order_service_query_errors_total{operation="${operation}"} ${this.errors.get(operation) ?? 0}`,
      ),
      '# HELP order_service_query_not_found_total Order Service queries for missing or unowned orders.',
      '# TYPE order_service_query_not_found_total counter',
      `order_service_query_not_found_total ${this.notFound}`,
      '# HELP order_service_query_duration_seconds Order Service query duration.',
      '# TYPE order_service_query_duration_seconds histogram',
      ...operations.map((operation) => {
        const duration = this.durations.get(operation);
        return DURATION_BUCKETS.map(
          (bucket, index) =>
            `order_service_query_duration_seconds_bucket{operation="${operation}",le="${bucket}"} ${duration?.buckets[index] ?? 0}`,
        )
          .concat(
            `order_service_query_duration_seconds_bucket{operation="${operation}",le="+Inf"} ${duration?.count ?? 0}`,
            `order_service_query_duration_seconds_sum{operation="${operation}"} ${duration?.sumSeconds ?? 0}`,
            `order_service_query_duration_seconds_count{operation="${operation}"} ${duration?.count ?? 0}`,
          )
          .join('\n');
      }),
      '',
    ].join('\n');
  }
}
