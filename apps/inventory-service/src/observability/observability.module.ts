import { Global, Module } from '@nestjs/common';

import { InventoryMetricsService } from './inventory-metrics.service';

@Global()
@Module({
  providers: [InventoryMetricsService],
  exports: [InventoryMetricsService],
})
export class ObservabilityModule {}
