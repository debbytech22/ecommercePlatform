import { jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';

import {
  InsufficientAvailableStockError,
  InventoryRepository,
} from './inventory.repository';
import { InventoryService } from './inventory.service';

describe('InventoryService', () => {
  const stockLevel = {
    productId: 'product-1',
    onHand: 10,
    reserved: 3,
    available: 7,
  };

  let repository: jest.Mocked<
    Pick<
      InventoryRepository,
      | 'createInventory'
      | 'increaseStock'
      | 'decreaseStock'
      | 'getStockLevel'
      | 'getAvailableQuantity'
    >
  >;
  let service: InventoryService;

  beforeEach(() => {
    repository = {
      createInventory: jest.fn().mockResolvedValue(stockLevel),
      increaseStock: jest.fn().mockResolvedValue(stockLevel),
      decreaseStock: jest.fn().mockResolvedValue(stockLevel),
      getStockLevel: jest.fn().mockResolvedValue(stockLevel),
      getAvailableQuantity: jest.fn().mockResolvedValue(7),
    };
    service = new InventoryService(
      repository as unknown as InventoryRepository,
    );
  });

  it('creates inventory with zero stock by default and returns derived availability', async () => {
    await expect(service.createInventory('product-1')).resolves.toEqual(
      stockLevel,
    );
    expect(repository.createInventory).toHaveBeenCalledWith('product-1', 0);
  });

  it('rejects invalid quantities before making a repository call', async () => {
    await expect(service.increaseStock('product-1', 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.increaseStock).not.toHaveBeenCalled();
  });

  it('rejects requested quantities larger than available stock', async () => {
    await expect(
      service.validateRequestedQuantity('product-1', 8),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('converts an atomic stock-decrease rejection to a conflict', async () => {
    repository.decreaseStock.mockRejectedValue(
      new InsufficientAvailableStockError('product-1', 8),
    );

    await expect(service.decreaseStock('product-1', 8)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
