import { Controller, Get, Header } from '@nestjs/common';
import { OrderQueryMetricsService } from './order-query-metrics.service';

@Controller('metrics')
export class OrderMetricsController {
  constructor(private readonly metrics: OrderQueryMetricsService) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(): string {
    return this.metrics.renderPrometheus();
  }
}
