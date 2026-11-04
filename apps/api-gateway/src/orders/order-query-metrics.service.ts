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
  private grpcFailures = 0;

  recordSuccess(operation: OrderQueryOperation, durationMs: number): void {
    this.requests.set(operation, (this.requests.get(operation) ?? 0) + 1);
    const current = this.durations.get(operation) ?? {
      count: 0,
      sumSeconds: 0,
      buckets: DURATION_BUCKETS.map(() => 0),
    };
    current.count += 1;
    const durationSeconds = durationMs / 1000;
    current.sumSeconds += durationSeconds;
    DURATION_BUCKETS.forEach((bucket, index) => {
      if (durationSeconds <= bucket) current.buckets[index] += 1;
    });
    this.durations.set(operation, current);
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

  recordGrpcFailure(): void {
    this.grpcFailures += 1;
  }

  renderPrometheus(): string {
    const operations: OrderQueryOperation[] = [
      'get',
      'list',
      'status',
      'timeline',
    ];
    return [
      '# HELP order_query_requests_total Order query requests by operation.',
      '# TYPE order_query_requests_total counter',
      ...operations.map(
        (operation) =>
          `order_query_requests_total{operation="${operation}"} ${this.requests.get(operation) ?? 0}`,
      ),
      '# HELP order_get_requests_total Order detail requests.',
      '# TYPE order_get_requests_total counter',
      `order_get_requests_total ${this.requests.get('get') ?? 0}`,
      '# HELP order_list_requests_total Customer order list requests.',
      '# TYPE order_list_requests_total counter',
      `order_list_requests_total ${this.requests.get('list') ?? 0}`,
      '# HELP order_query_errors_total Order query failures by operation.',
      '# TYPE order_query_errors_total counter',
      ...operations.map(
        (operation) =>
          `order_query_errors_total{operation="${operation}"} ${this.errors.get(operation) ?? 0}`,
      ),
      '# HELP order_not_found_total Orders not found or not owned by the requesting customer.',
      '# TYPE order_not_found_total counter',
      `order_not_found_total ${this.notFound}`,
      '# HELP order_grpc_failures_total gRPC service communication failures.',
      '# TYPE order_grpc_failures_total counter',
      `order_grpc_failures_total ${this.grpcFailures}`,
      '# HELP order_query_duration_seconds Order query duration.',
      '# TYPE order_query_duration_seconds histogram',
      ...operations.map((operation) => {
        const duration = this.durations.get(operation);
        return DURATION_BUCKETS.map(
          (bucket, index) =>
            `order_query_duration_seconds_bucket{operation="${operation}",le="${bucket}"} ${duration?.buckets[index] ?? 0}`,
        )
          .concat(
            `order_query_duration_seconds_bucket{operation="${operation}",le="+Inf"} ${duration?.count ?? 0}`,
            `order_query_duration_seconds_sum{operation="${operation}"} ${duration?.sumSeconds ?? 0}`,
            `order_query_duration_seconds_count{operation="${operation}"} ${duration?.count ?? 0}`,
          )
          .join('\n');
      }),
      '',
    ].join('\n');
  }
}
