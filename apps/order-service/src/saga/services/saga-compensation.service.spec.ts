import { jest } from '@jest/globals';
import type { EntityManager } from 'typeorm';
import { OutboxEventEntity } from '../../entities/outbox-event.entity';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaStepEntity, SagaStepType } from '../entities/saga-step.entity';
import { SagaState } from '../enums/saga-state.enum';
import { SagaStepStatus } from '../enums/saga-step-status.enum';
import { SagaCompensationService } from './saga-compensation.service';

describe('SagaCompensationService', () => {
  it('retries with a new command ID while preserving the logical operation ID', async () => {
    const saga = {
      id: 'saga-1',
      orderId: 'order-1',
      correlationId: 'correlation-1',
      paymentOperationId: 'payment-operation-1',
      failureCode: 'ORDER_CANCELLED',
      currentState: SagaState.COMPENSATING,
    };
    const step = {
      id: 'step-void-1',
      sagaId: saga.id,
      stepType: SagaStepType.PAYMENT_VOID,
      commandId: null as string | null,
      status: SagaStepStatus.PENDING,
      attemptCount: 0,
      lastError: null as string | null,
      startedAt: null as Date | null,
      completedAt: null as Date | null,
    };
    const stepRepository = {
      findOneByOrFail: jest.fn().mockResolvedValue(step),
      save: jest.fn().mockResolvedValue(step),
    };
    const sagaRepository = {
      save: jest.fn().mockResolvedValue(saga),
    };
    const outboxRepository = {
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const repositories = new Map<Function, object>([
      [SagaStepEntity, stepRepository],
      [OrderSagaEntity, sagaRepository],
      [OutboxEventEntity, outboxRepository],
    ]);
    const manager = {
      getRepository: jest.fn((entity: Function) => {
        const repository = repositories.get(entity);
        if (!repository) throw new Error('Unexpected repository');
        return repository;
      }),
    } as unknown as EntityManager;
    const service = new SagaCompensationService();

    await service.requestPaymentVoid(
      manager,
      saga as OrderSagaEntity,
      'authorization-1',
      'cancel-event-1',
    );
    const firstCommandId = step.commandId;

    expect(outboxRepository.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: 'payment.void.v1',
        payload: expect.objectContaining({
          commandId: firstCommandId,
          commandType: 'payment.void.v1',
          payload: {
            paymentOperationId: 'payment-operation-1',
            sagaId: 'saga-1',
            authorizationId: 'authorization-1',
            voidOperationId: 'step-void-1',
            orderId: 'order-1',
            reasonCode: expect.any(String),
          },
          causationId: 'cancel-event-1',
        }),
      }),
    );

    step.commandId = null;
    step.status = SagaStepStatus.PENDING;
    await service.requestPaymentVoid(
      manager,
      saga as OrderSagaEntity,
      'authorization-1',
      'void-failed-event-1',
      1000,
    );

    expect(step.commandId).not.toBe(firstCommandId);
    expect(step.attemptCount).toBe(2);
    expect(outboxRepository.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: 'payment.void.v1',
        payload: expect.objectContaining({
          commandId: step.commandId,
          commandType: 'payment.void.v1',
          payload: expect.objectContaining({
            paymentOperationId: 'payment-operation-1',
            sagaId: 'saga-1',
            voidOperationId: 'step-void-1',
          }),
          causationId: 'void-failed-event-1',
        }),
        nextAttemptAt: expect.any(Date),
      }),
    );
    expect(outboxRepository.save).toHaveBeenCalledTimes(2);
  });
});
