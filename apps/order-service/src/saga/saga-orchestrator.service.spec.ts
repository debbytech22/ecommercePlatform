import { jest } from '@jest/globals';
import type { DataSource, EntityManager } from 'typeorm';
import type { InventoryReservedEvent } from 'default/contracts';
import { InboxEventEntity } from '../inbox/inbox-event.entity';
import { OrderItemEntity } from '../entities/order-item.entity';
import { OrderEntity, OrderStatus } from '../entities/order.entity';
import { OrderStatusHistoryEntity } from '../entities/order-status-history.entity';
import { OutboxEventEntity } from '../entities/outbox-event.entity';
import { SagaState } from './enums/saga-state.enum';
import { SagaStepStatus } from './enums/saga-step-status.enum';
import { OrderSagaEntity } from './entities/order-saga.entity';
import { SagaStepEntity, SagaStepType } from './entities/saga-step.entity';
import { SagaOrchestratorService } from './saga-orchestrator.service';
import { SagaCompensationService } from './services/saga-compensation.service';
import { PaymentResultProcessor } from './confirmation/payment-result.processor';
import { CompensationOrchestratorService } from './compensation/compensation-orchestrator.service';
import { OrderConfirmationMetricsService } from './confirmation/order-confirmation-metrics.service';
import type { PaymentAuthorizedEvent } from 'default/contracts';

describe('SagaOrchestratorService', () => {
  it('voids a late authorization after the Saga was compensated', async () => {
    const saga = {
      id: 'saga-1',
      orderId: 'order-1',
      currentState: SagaState.COMPENSATED,
      correlationId: 'correlation-1',
      paymentOperationId: 'authorization-operation-1',
      paymentAuthorizationId: null as string | null,
      paymentId: null as string | null,
      paymentAmount: null as string | null,
      paymentCurrency: null as string | null,
      paymentStatus: null as 'AUTHORIZED' | 'CAPTURED' | null,
      compensationStatus: 'COMPLETED',
      compensationReason: null,
      compensationStartedAt: new Date(),
      compensationCompletedAt: new Date(),
      completedAt: new Date(),
    };
    const order = {
      id: 'order-1',
      totalAmount: '25.0000',
      currency: 'USD',
      status: OrderStatus.CANCELLED,
    };
    const paymentStep = {
      id: 'payment-step-1',
      sagaId: saga.id,
      stepType: SagaStepType.PAYMENT_AUTHORIZATION,
      status: SagaStepStatus.FAILED,
      commandId: 'authorize-command-1',
      completedAt: new Date(),
      deadlineAt: null,
      lastError: 'PAYMENT_AUTHORIZATION_FAILED',
    };
    const voidStep = {
      id: 'void-step-1',
      sagaId: saga.id,
      stepType: SagaStepType.PAYMENT_VOID,
      status: SagaStepStatus.PENDING,
      commandId: null,
      operationId: 'void-step-1',
      attemptCount: 0,
    };
    const inboxRepository = {
      insert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const sagaRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(saga),
      })),
      save: jest.fn(async (value: typeof saga) => value),
    };
    const orderRepository = {
      findOneByOrFail: jest.fn().mockResolvedValue(order),
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
      findOneByOrFail: jest.fn(({ stepType }: { stepType: SagaStepType }) =>
        Promise.resolve(
          stepType === SagaStepType.PAYMENT_AUTHORIZATION
            ? paymentStep
            : voidStep,
        ),
      ),
      save: jest.fn(
        async (value: typeof paymentStep | typeof voidStep) => value,
      ),
    };
    const repositories = new Map<Function, object>([
      [InboxEventEntity, inboxRepository],
      [OrderSagaEntity, sagaRepository],
      [OrderEntity, orderRepository],
      [OrderStatusHistoryEntity, historyRepository],
      [SagaStepEntity, stepRepository],
    ]);
    const manager = {
      getRepository: jest.fn((entity: Function) => {
        const repository = repositories.get(entity);
        if (!repository) throw new Error('Unexpected repository');
        return repository;
      }),
    };
    const dataSource = {
      transaction: jest.fn(
        async (operation: (value: EntityManager) => Promise<void>) =>
          operation(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const requestPaymentVoid = jest.fn(async () => undefined);
    const service = new SagaOrchestratorService(
      dataSource,
      { requestPaymentVoid } as unknown as SagaCompensationService,
      {
        processAuthorization: jest.fn(),
      } as unknown as PaymentResultProcessor,
      {} as CompensationOrchestratorService,
      new OrderConfirmationMetricsService(),
    );
    const event: PaymentAuthorizedEvent = {
      eventId: 'late-payment-authorized-event',
      eventType: 'payment.authorized.v1',
      eventVersion: 1,
      aggregateId: order.id,
      occurredAt: new Date().toISOString(),
      correlationId: saga.correlationId,
      causationId: paymentStep.commandId,
      payload: {
        orderId: order.id,
        paymentId: 'payment-1',
        paymentOperationId: saga.paymentOperationId,
        authorizationId: 'authorization-1',
        amount: order.totalAmount,
        currency: order.currency,
      },
    };

    await service.paymentAuthorized(event);

    expect(saga.currentState).toBe(SagaState.COMPENSATING);
    expect(saga.paymentStatus).toBe('AUTHORIZED');
    expect(paymentStep.status).toBe(SagaStepStatus.SUCCEEDED);
    expect(order.status).toBe(OrderStatus.CANCELLATION_PENDING);
    expect(requestPaymentVoid).toHaveBeenCalledWith(
      expect.anything(),
      saga,
      'authorization-1',
      event.eventId,
    );
  });

  it('starts payment only after an inventory reservation is persisted', async () => {
    const saga = {
      id: 'saga-1',
      orderId: 'order-1',
      currentState: SagaState.INVENTORY_RESERVATION_PENDING,
      correlationId: 'correlation-1',
      inventoryReservationId: null,
      paymentOperationId: null,
      failureCode: null,
      failureReason: null,
    };
    const reservationStep = {
      sagaId: saga.id,
      stepType: SagaStepType.INVENTORY_RESERVATION,
      status: SagaStepStatus.PENDING,
      commandId: null,
      attemptCount: 0,
      lastError: null,
      startedAt: null,
      completedAt: null,
    };
    const paymentStep = {
      sagaId: saga.id,
      stepType: SagaStepType.PAYMENT_AUTHORIZATION,
      status: SagaStepStatus.PENDING,
      commandId: null,
      attemptCount: 0,
      lastError: null,
      startedAt: null,
      completedAt: null,
    };
    const order = {
      id: 'order-1',
      customerId: 'customer-1',
      totalAmount: '25.0000',
      currency: 'USD',
      status: OrderStatus.PENDING,
    };
    const inboxRepository = {
      insert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const sagaRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(saga),
      })),
      save: jest.fn().mockResolvedValue(saga),
    };
    const stepRepository = {
      findOneByOrFail: jest.fn(({ stepType }: { stepType: SagaStepType }) =>
        Promise.resolve(
          stepType === SagaStepType.INVENTORY_RESERVATION
            ? reservationStep
            : paymentStep,
        ),
      ),
      save: jest.fn().mockResolvedValue(reservationStep),
    };
    const orderRepository = {
      findOneByOrFail: jest.fn().mockResolvedValue(order),
      save: jest.fn().mockResolvedValue(order),
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
    const orderItemRepository = {
      find: jest
        .fn()
        .mockResolvedValue([{ productId: 'product-1', quantity: 2 }]),
    };
    const outboxRepository = {
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const repositories = new Map<Function, object>([
      [InboxEventEntity, inboxRepository],
      [OrderSagaEntity, sagaRepository],
      [SagaStepEntity, stepRepository],
      [OrderEntity, orderRepository],
      [OrderStatusHistoryEntity, historyRepository],
      [OrderItemEntity, orderItemRepository],
      [OutboxEventEntity, outboxRepository],
    ]);
    const manager = {
      getRepository: jest.fn((entity: Function) => {
        const repository = repositories.get(entity);
        if (!repository) throw new Error('Unexpected repository');
        return repository;
      }),
    };
    const dataSource = {
      transaction: jest.fn(
        async (operation: (value: EntityManager) => Promise<void>) =>
          operation(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const compensation = {} as SagaCompensationService;
    const service = new SagaOrchestratorService(
      dataSource,
      compensation,
      {} as PaymentResultProcessor,
      {} as CompensationOrchestratorService,
      new OrderConfirmationMetricsService(),
    );
    const event: InventoryReservedEvent = {
      eventId: 'inventory-event-1',
      eventType: 'inventory.reserved.v1',
      eventVersion: 1,
      aggregateId: 'order-1',
      occurredAt: new Date().toISOString(),
      correlationId: 'correlation-1',
      causationId: 'correlation-1',
      payload: {
        orderId: 'order-1',
        reservationId: 'reservation-1',
        items: [{ productId: 'product-1', quantity: 2 }],
      },
    };

    await service.inventoryReserved(event);

    expect(saga.currentState).toBe(SagaState.PAYMENT_PENDING);
    expect(saga.inventoryReservationId).toBe('reservation-1');
    expect(reservationStep.status).toBe(SagaStepStatus.SUCCEEDED);
    expect(paymentStep.commandId).toEqual(expect.any(String));
    expect(paymentStep.attemptCount).toBe(1);
    expect(order.status).toBe(OrderStatus.PROCESSING_PAYMENT);
    expect(outboxRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'payment.authorize.v1',
        aggregateId: 'order-1',
        payload: expect.objectContaining({
          commandId: paymentStep.commandId,
          commandType: 'payment.authorize.v1',
          payload: {
            orderId: 'order-1',
            customerId: 'customer-1',
            amount: '25.0000',
            currency: 'USD',
            paymentOperationId: expect.any(String),
          },
          correlationId: 'correlation-1',
          causationId: 'inventory-event-1',
        }),
      }),
    );
    expect(inboxRepository.update).toHaveBeenCalledWith(
      { eventId: 'inventory-event-1' },
      { processingStatus: 'PROCESSED', processedAt: expect.any(Date) },
    );
  });
});
