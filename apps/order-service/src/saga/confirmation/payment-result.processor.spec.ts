import { jest } from '@jest/globals';
import type { DataSource, EntityManager } from 'typeorm';
import type { PaymentAuthorizedEvent } from 'default/contracts';
import { OrderItemEntity } from '../../entities/order-item.entity';
import { OutboxEventEntity } from '../../entities/outbox-event.entity';
import { OrderEntity, OrderStatus } from '../../orders/entities/order.entity';
import { OrdersService } from '../../orders/orders.service';
import { SagaState } from '../enums/saga-state.enum';
import { SagaStepStatus } from '../enums/saga-step-status.enum';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaStepEntity, SagaStepType } from '../entities/saga-step.entity';
import { OrderConfirmationService } from './order-confirmation.service';
import { OrderConfirmationValidator } from './order-confirmation.validator';
import { PaymentResultProcessor } from './payment-result.processor';

describe('PaymentResultProcessor', () => {
  function setup() {
    const saga = {
      id: 'saga-1',
      orderId: 'order-1',
      currentState: SagaState.PAYMENT_PENDING,
      correlationId: 'correlation-1',
      inventoryReservationId: 'reservation-1',
      inventoryReservationStatus: 'RESERVED',
      inventoryReservationItems: [{ productId: 'product-1', quantity: 2 }],
      paymentOperationId: 'payment-operation-1',
      paymentAuthorizationId: null,
      paymentId: null,
      paymentAmount: null,
      paymentCurrency: null,
      paymentStatus: null,
    };
    const order = {
      id: saga.orderId,
      customerId: 'customer-1',
      status: OrderStatus.PROCESSING_PAYMENT,
      totalAmount: '25.0000',
      currency: 'USD',
    };
    const orderItems = [{ productId: 'product-1', quantity: 2 }];
    const inventoryStep = {
      sagaId: saga.id,
      stepType: SagaStepType.INVENTORY_RESERVATION,
      status: SagaStepStatus.SUCCEEDED,
    };
    const paymentStep = {
      sagaId: saga.id,
      stepType: SagaStepType.PAYMENT_AUTHORIZATION,
      status: SagaStepStatus.IN_PROGRESS,
      commandId: 'payment-command-1',
      completedAt: null as Date | null,
      deadlineAt: new Date(),
      lastError: 'old error',
    };
    const outboxSave = jest.fn(async (value: Record<string, unknown>) => value);
    const sagaRepository = {
      save: jest.fn(async (value: typeof saga) => value),
      findOne: jest.fn(async () => saga),
    };
    const stepRepository = {
      findOne: jest.fn(({ where }: { where: { stepType: SagaStepType } }) =>
        Promise.resolve(
          where.stepType === SagaStepType.INVENTORY_RESERVATION
            ? inventoryStep
            : paymentStep,
        ),
      ),
      save: jest.fn(async (value: typeof paymentStep) => value),
    };
    const orderRepository = {
      save: jest.fn(async (value: typeof order) => value),
    };
    const outboxRepository = {
      save: outboxSave,
      findOneBy: jest.fn(async () => ({ id: saga.id })),
    };
    const repositories = new Map<Function, object>([
      [OrderSagaEntity, sagaRepository],
      [SagaStepEntity, stepRepository],
      [OrderEntity, orderRepository],
      [OrderItemEntity, { find: jest.fn(async () => orderItems) }],
      [OutboxEventEntity, outboxRepository],
    ]);
    const manager = {
      getRepository: (entity: Function) => {
        const repository = repositories.get(entity);
        if (!repository) throw new Error('Unexpected repository');
        return repository;
      },
    } as unknown as EntityManager;
    const orders = {
      findForUpdate: jest.fn(async () => order),
      findItems: jest.fn(async () => orderItems),
    } as unknown as OrdersService;
    const validator = new OrderConfirmationValidator();
    const confirmation = new OrderConfirmationService(
      {} as DataSource,
      orders,
      validator,
    );
    const processor = new PaymentResultProcessor(confirmation);
    const event: PaymentAuthorizedEvent = {
      eventId: 'payment-event-1',
      eventType: 'payment.authorized.v1',
      eventVersion: 1,
      aggregateId: saga.orderId,
      occurredAt: '2026-11-02T13:00:00.000Z',
      correlationId: saga.correlationId,
      causationId: paymentStep.commandId,
      payload: {
        paymentId: 'payment-1',
        orderId: saga.orderId,
        paymentOperationId: saga.paymentOperationId,
        authorizationId: 'authorization-1',
        amount: '25.0000',
        currency: 'USD',
        providerReference: null,
      },
    };

    return {
      event,
      inventoryStep,
      order,
      outboxSave,
      paymentStep,
      processor,
      saga,
      stepRepository,
      manager,
    };
  }

  it('confirms only an eligible, fully matching authorized order', async () => {
    const test = setup();

    await test.processor.processAuthorization(test.manager, test.event);

    expect(test.saga).toMatchObject({
      currentState: SagaState.COMPLETED,
      paymentId: 'payment-1',
      paymentOperationId: 'payment-operation-1',
      paymentAuthorizationId: 'authorization-1',
      paymentAmount: '25.0000',
      paymentCurrency: 'USD',
      paymentStatus: 'AUTHORIZED',
    });
    expect(test.paymentStep).toMatchObject({
      status: SagaStepStatus.SUCCEEDED,
      deadlineAt: null,
      lastError: null,
    });
    expect(test.order.status).toBe(OrderStatus.CONFIRMED);
    expect(test.outboxSave).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'order.confirmed.v1',
        id: 'saga-1',
        payload: expect.objectContaining({
          eventId: 'saga-1',
          correlationId: 'correlation-1',
          causationId: 'payment-event-1',
          payload: {
            orderId: 'order-1',
            customerId: 'customer-1',
            inventoryReservationId: 'reservation-1',
            paymentId: 'payment-1',
            paymentOperationId: 'payment-operation-1',
            paymentStatus: 'AUTHORIZED',
            amount: '25.0000',
            currency: 'USD',
            confirmedAt: expect.any(String),
          },
        }),
      }),
    );
  });

  it('rejects amount mismatch before confirmation state or event is persisted', async () => {
    const test = setup();
    test.event.payload.amount = '24.0000';

    await expect(
      test.processor.processAuthorization(test.manager, test.event),
    ).rejects.toThrow(
      'Payment authorization does not match the persisted order total',
    );

    expect(test.saga.currentState).toBe(SagaState.PAYMENT_PENDING);
    expect(test.stepRepository.save).not.toHaveBeenCalled();
    expect(test.outboxSave).not.toHaveBeenCalled();
  });

  it('does not create another confirmation event for a duplicate result', async () => {
    const test = setup();
    await test.processor.processAuthorization(test.manager, test.event);
    test.outboxSave.mockClear();

    await test.processor.processAuthorization(test.manager, test.event);

    expect(test.saga.currentState).toBe(SagaState.COMPLETED);
    expect(test.outboxSave).not.toHaveBeenCalled();
  });

  it('rejects confirmation when the persisted reservation was released', async () => {
    const test = setup();
    test.saga.inventoryReservationStatus = 'RELEASED';

    await expect(
      test.processor.processAuthorization(test.manager, test.event),
    ).rejects.toThrow(
      'Order is not eligible for confirmation from this payment result',
    );

    expect(test.order.status).toBe(OrderStatus.PROCESSING_PAYMENT);
    expect(test.outboxSave).not.toHaveBeenCalled();
  });
});
