import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import {
  InsufficientAvailableStockError,
  InventoryRepository,
  StockQuantityOverflowError,
} from './inventory.repository';
import type { InventoryStockLevel } from './inventory.repository';

@Injectable()
export class InventoryService {
  constructor(private readonly inventory: InventoryRepository) {}

  async createInventory(
    productId: string,
    initialOnHand = 0,
  ): Promise<InventoryStockLevel> {
    this.validateProductId(productId);
    this.validateQuantity(initialOnHand, true);
    try {
      return await this.inventory.createInventory(productId, initialOnHand);
    } catch (error) {
      if (this.isDuplicateProduct(error)) {
        throw new ConflictException(
          `Inventory for product ${productId} already exists`,
        );
      }
      throw error;
    }
  }

  async increaseStock(
    productId: string,
    quantity: number,
  ): Promise<InventoryStockLevel> {
    this.validateProductId(productId);
    this.validateQuantity(quantity);
    try {
      return await this.inventory.increaseStock(productId, quantity);
    } catch (error) {
      if (error instanceof StockQuantityOverflowError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  async decreaseStock(
    productId: string,
    quantity: number,
  ): Promise<InventoryStockLevel> {
    this.validateProductId(productId);
    this.validateQuantity(quantity);
    try {
      return await this.inventory.decreaseStock(productId, quantity);
    } catch (error) {
      if (error instanceof InsufficientAvailableStockError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  getStockLevel(productId: string): Promise<InventoryStockLevel> {
    this.validateProductId(productId);
    return this.inventory.getStockLevel(productId);
  }

  async validateRequestedQuantity(
    productId: string,
    quantity: number,
  ): Promise<void> {
    this.validateProductId(productId);
    this.validateQuantity(quantity);

    const available = await this.inventory.getAvailableQuantity(productId);
    if (available < quantity) {
      throw new ConflictException(
        `Insufficient available stock for product ${productId}`,
      );
    }
  }

  private validateProductId(productId: string): void {
    if (
      typeof productId !== 'string' ||
      productId.trim().length === 0 ||
      productId.length > 120
    ) {
      throw new BadRequestException(
        'productId must be a non-empty string of at most 120 characters',
      );
    }
  }

  private validateQuantity(quantity: number, allowZero = false): void {
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < (allowZero ? 0 : 1) ||
      quantity > 4_294_967_295
    ) {
      throw new BadRequestException(
        allowZero
          ? 'quantity must be a non-negative integer within the supported stock range'
          : 'quantity must be a positive integer within the supported stock range',
      );
    }
  }

  private isDuplicateProduct(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }

    const driverError: unknown = error.driverError;
    if (typeof driverError !== 'object' || driverError === null) {
      return false;
    }

    return 'code' in driverError && driverError.code === 'ER_DUP_ENTRY';
  }
}
