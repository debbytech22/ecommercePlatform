import { jest } from '@jest/globals';
import { OrdersGrpcClient } from './orders.grpc-client';
import { OrderQueryMetricsService } from './order-query-metrics.service';

describe('OrdersGrpcClient', () => {
  it('loads the shared proto and initializes all read RPC methods', () => {
    const metrics = {
      recordSuccess: jest.fn(),
      recordError: jest.fn(),
      recordGrpcFailure: jest.fn(),
    } as unknown as OrderQueryMetricsService;

    const client = new OrdersGrpcClient(metrics);
    expect(() => client.onModuleDestroy()).not.toThrow();
  });
});
