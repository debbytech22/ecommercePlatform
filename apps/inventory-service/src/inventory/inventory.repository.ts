import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ProductInventoryEntity } from './entities/product-inventory.entity';

export interface InventoryStockLevel {
  productId: string;
  onHand: number;
  reserved: number;
  available: number;
}

export class InsufficientAvailableStockError extends Error {
  constructor(productId: string, requestedQuantity: number) {
    super(
      `Cannot decrease stock for product ${productId}: ${requestedQuantity} exceeds available stock`,
    );
    this.name = 'InsufficientAvailableStockError';
  }
}

export class StockQuantityOverflowError extends Error {
  constructor(productId: string) {
    super(`Stock adjustment exceeds the supported quantity for ${productId}`);
    this.name = 'StockQuantityOverflowError';
  }
}

const MAX_STOCK_QUANTITY = 4_294_967_295;

@Injectable()
export class InventoryRepository {
  constructor(private readonly dataSource: DataSource) {}

  async createInventory(
    productId: string,
    initialOnHand: number,
  ): Promise<InventoryStockLevel> {
    return this.dataSource.transaction(async (manager) => {
      await manager.insert(ProductInventoryEntity, {
        productId,
        onHand: initialOnHand,
        reserved: 0,
      });
      return this.getStockLevelWithManager(manager, productId);
    });
  }

  async increaseStock(
    productId: string,
    quantity: number,
  ): Promise<InventoryStockLevel> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(ProductInventoryEntity)
        .set({ onHand: () => '`on_hand` + :quantity' })
        .where('product_id = :productId', { productId })
        .andWhere('on_hand <= :maximum', {
          maximum: MAX_STOCK_QUANTITY - quantity,
        })
        .setParameter('quantity', quantity)
        .execute();

      if (result.affected !== 1) {
        await this.ensureProductExists(manager, productId);
        throw new StockQuantityOverflowError(productId);
      }

      return this.getStockLevelWithManager(manager, productId);
    });
  }

  async decreaseStock(
    productId: string,
    quantity: number,
  ): Promise<InventoryStockLevel> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(ProductInventoryEntity)
        .set({ onHand: () => '`on_hand` - :quantity' })
        .where('product_id = :productId', { productId })
        .andWhere('on_hand - reserved >= :quantity', { quantity })
        .setParameter('quantity', quantity)
        .execute();

      if (result.affected !== 1) {
        await this.ensureProductExists(manager, productId);
        throw new InsufficientAvailableStockError(productId, quantity);
      }

      return this.getStockLevelWithManager(manager, productId);
    });
  }

  async getStockLevel(productId: string): Promise<InventoryStockLevel> {
    return this.dataSource.transaction((manager) =>
      this.getStockLevelWithManager(manager, productId),
    );
  }

  async getAvailableQuantity(productId: string): Promise<number> {
    const level = await this.getStockLevel(productId);
    return level.available;
  }

  private async getStockLevelWithManager(
    manager: EntityManager,
    productId: string,
  ): Promise<InventoryStockLevel> {
    const inventory = await manager.findOneBy(ProductInventoryEntity, {
      productId,
    });
    if (!inventory) {
      throw new NotFoundException(
        `Inventory record for product ${productId} was not found`,
      );
    }

    return {
      productId: inventory.productId,
      onHand: inventory.onHand,
      reserved: inventory.reserved,
      available: inventory.onHand - inventory.reserved,
    };
  }

  private async ensureProductExists(
    manager: EntityManager,
    productId: string,
  ): Promise<void> {
    const exists = await manager.existsBy(ProductInventoryEntity, {
      productId,
    });
    if (!exists) {
      throw new NotFoundException(
        `Inventory record for product ${productId} was not found`,
      );
    }
  }
}
