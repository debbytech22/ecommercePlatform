import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProductInventoryEntity } from './entities/product-inventory.entity';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';

@Module({
  imports: [TypeOrmModule.forFeature([ProductInventoryEntity])],
  providers: [InventoryRepository, InventoryService],
  exports: [InventoryRepository, InventoryService],
})
export class InventoryModule {}
