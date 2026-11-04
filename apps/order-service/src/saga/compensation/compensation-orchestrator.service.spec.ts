import { ConflictException } from '@nestjs/common';
import { jest } from '@jest/globals';
import type { DataSource, EntityManager } from 'typeorm';
import { OrderEntity, OrderStatus } from '../../entities/order.entity';
import { OrderStatusHistoryEntity } from '../../entities/order-status-history.entity';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaStepEntity } from '../entities/saga-step.entity';
import { SagaState } from '../enums/saga-state.enum';
import { SagaCompensationService } from '../services/saga-compensation.service';
import { CompensationPolicyService } from './compensation-policy.service';
import { CompensationOrchestratorService } from './compensation-orchestrator.service';
import { CompensationStateValidator } from './compensation-state.validator';
import { CompensationReason, CompensationStatus } from './compensation.types';

describe('CompensationOrchestratorService', () => {
  function setup() {
    const saga = {
      id: 'saga-1',
      orderId: 'order-1',
      currentState: SagaState.COMPLETED,
      paymentOperationId: 'payment-operation-1',
      paymentAuthorizationId: 'authorization-1',
      paymentStatus: 'AUTHORIZED',
      inventoryReservationId: 'reservation-1',
      inventoryReservationStatus: 'RESERVED',
      failureCode: null as string | null,
      failureReason: null as string | null,
      compensationCausationId: null as string | null,
      completedAt: new Date(),
    };
    const order = { id: 'order-1', status: OrderStatus.CONFIRMED };
    const sagaRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => saga),
      })),
      save: jest.fn(async (value: typeof saga) => value),
    };
    const orderRepository = {
      findOneByOrFail: jest.fn(async () => order),
      save: jest.fn(async (value: typeof order) => value),
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(order),
      })),
    };
    const historyRepository = {
      insert: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        maxExecutionTime: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ nextSequence: 1 }),
      })),
    };
    const stepRepository = {
      findBy: jest.fn(async () => []),
    };
    const manager = {
      getRepository: jest.fn((entity: Function) => {
        if (entity === OrderSagaEntity) return sagaRepository;
        if (entity === SagaStepEntity) return stepRepository;
        if (entity === OrderStatusHistoryEntity) return historyRepository;
        return orderRepository;
      }),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(
        async (
          operation: (transactionManager: EntityManager) => Promise<void>,
        ) => operation(manager),
      ),
    } as unknown as DataSource;
    const requestPaymentVoid =
      jest.fn<
        (
          manager: EntityManager,
          targetSaga: OrderSagaEntity,
          authorizationId: string,
          causationId: string,
        ) => Promise<void>
      >();
    requestPaymentVoid.mockImplementation(async (_manager, targetSaga) => {
      targetSaga.currentState = SagaState.COMPENSATION_PENDING;
      targetSaga.compensationStatus = CompensationStatus.IN_PROGRESS;
    });
    const commands = {
      requestPaymentVoid,
      requestPaymentRefund: jest.fn(async () => undefined),
      requestInventoryRelease: jest.fn(async () => undefined),
    } as unknown as SagaCompensationService;
    const service = new CompensationOrchestratorService(
      dataSource,
      commands,
      new CompensationPolicyService(),
      new CompensationStateValidator(),
    );
    return { commands, order, saga, service };
  }

  it('voids an authorization and marks the confirmed order cancellation-pending atomically', async () => {
    const test = setup();

    await test.service.startCompensation(
      'order-1',
      CompensationReason.ORDER_CANCELLATION,
      'Order cancellation requested',
      'cancel-event-1',
    );

    expect(test.saga).toMatchObject({
      currentState: SagaState.COMPENSATION_PENDING,
      failureCode: CompensationReason.ORDER_CANCELLATION,
      compensationCausationId: 'cancel-event-1',
      compensationReason: CompensationReason.ORDER_CANCELLATION,
      compensationStatus: CompensationStatus.IN_PROGRESS,
    });
    expect(test.order.status).toBe(OrderStatus.CANCELLATION_PENDING);
    expect(test.commands.requestPaymentVoid).toHaveBeenCalledWith(
      expect.anything(),
      test.saga,
      'authorization-1',
      'cancel-event-1',
    );
  });

  it('treats the same request as idempotent and rejects a different request', async () => {
    const test = setup();
    await test.service.startCompensation(
      'order-1',
      CompensationReason.ORDER_CANCELLATION,
      'Order cancellation requested',
      'cancel-event-1',
    );
    const commandCalls = jest.mocked(test.commands.requestPaymentVoid).mock
      .calls.length;

    await test.service.startCompensation(
      'order-1',
      CompensationReason.ORDER_CANCELLATION,
      'Order cancellation requested',
      'cancel-event-1',
    );
    await expect(
      test.service.startCompensation(
        'order-1',
        CompensationReason.ORDER_CANCELLATION,
        'Another cancellation request',
        'different-event',
      ),
    ).rejects.toThrow(ConflictException);

    expect(
      jest.mocked(test.commands.requestPaymentVoid).mock.calls.length,
    ).toBe(commandCalls);
  });
});
