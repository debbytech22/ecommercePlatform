import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersGrpcClient } from './orders.grpc-client';
import { OrderQueryMetricsService } from './order-query-metrics.service';
import { OrderMetricsController } from './order-metrics.controller';

@Module({
  controllers: [OrdersController, OrderMetricsController],
  providers: [OrdersGrpcClient, OrderQueryMetricsService],
})
export class OrdersModule {}
