import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity } from './entities/order.entity';
import { OrderStatusHistoryEntity } from '../entities/order-status-history.entity';
import { OrderQueryRepository } from './queries/order-query.repository';
import { OrderQueryMetricsService } from './queries/order-query-metrics.service';
import { OrdersService } from './orders.service';

@Module({
  imports: [TypeOrmModule.forFeature([OrderEntity, OrderStatusHistoryEntity])],
  providers: [OrdersService, OrderQueryRepository, OrderQueryMetricsService],
  exports: [OrdersService, OrderQueryRepository, OrderQueryMetricsService],
})
export class OrdersModule {}
