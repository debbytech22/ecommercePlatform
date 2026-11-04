import { jest } from '@jest/globals';
import { DataSource, EntityManager } from 'typeorm';

import { InventoryRepository } from './inventory.repository';

describe('InventoryRepository stock concurrency', () => {
  it('runs stock decrease as an atomic conditional update inside a transaction', async () => {
    const execute = jest.fn<() => Promise<{ affected: number }>>();
    execute.mockResolvedValue({ affected: 1 });
    const setParameter = jest.fn().mockReturnThis();
    const andWhere = jest.fn().mockReturnThis();
    const where = jest.fn().mockReturnThis();
    const set = jest.fn().mockReturnThis();
    const update = jest.fn().mockReturnValue({
      set,
      where,
      andWhere,
      setParameter,
      execute,
    });
    const createQueryBuilder = jest.fn().mockReturnValue({ update });
    const findOneBy = jest.fn().mockResolvedValue({
      productId: 'product-1',
      onHand: 6,
      reserved: 3,
    });
    const manager = {
      createQueryBuilder,
      findOneBy,
    };
    const transaction = jest
      .fn<
        (
          operation: (manager: EntityManager) => Promise<unknown>,
        ) => Promise<unknown>
      >()
      .mockImplementation((operation) =>
        operation(manager as unknown as EntityManager),
      );
    const dataSource = { transaction };
    const repository = new InventoryRepository(
      dataSource as unknown as DataSource,
    );

    await expect(repository.decreaseStock('product-1', 2)).resolves.toEqual({
      productId: 'product-1',
      onHand: 6,
      reserved: 3,
      available: 3,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(andWhere).toHaveBeenCalledWith('on_hand - reserved >= :quantity', {
      quantity: 2,
    });
    expect(set).toHaveBeenCalledWith({
      onHand: expect.any(Function),
    });
  });
});
