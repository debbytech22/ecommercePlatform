import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { SagaStepStatus } from '../enums/saga-step-status.enum';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaStepEntity, SagaStepType } from '../entities/saga-step.entity';
import { SagaState } from '../enums/saga-state.enum';
import {
  SAGA_TIMEOUT_CONFIG,
  type SagaTimeoutConfig,
} from '../config/saga-timeout.config';

@Injectable()
export class SagaInitializerService {
  constructor(
    @Inject(SAGA_TIMEOUT_CONFIG)
    private readonly timeouts: SagaTimeoutConfig,
  ) {}

  async initialize(
    manager: EntityManager,
    orderId: string,
    correlationId: string,
  ): Promise<OrderSagaEntity> {
    const sagaRepository = manager.getRepository(OrderSagaEntity);
    const stepRepository = manager.getRepository(SagaStepEntity);
    const saga = await sagaRepository.save(
      sagaRepository.create({
        id: randomUUID(),
        orderId,
        currentState: SagaState.INVENTORY_RESERVATION_PENDING,
        correlationId,
        inventoryReservationId: null,
        inventoryReservationStatus: null,
        inventoryReservationItems: null,
        paymentOperationId: null,
        paymentAuthorizationId: null,
        paymentId: null,
        paymentAmount: null,
        paymentCurrency: null,
        paymentStatus: null,
        failureCode: null,
        failureReason: null,
        compensationCausationId: null,
        compensationReason: null,
        compensationStatus: null,
        compensationStartedAt: null,
        compensationCompletedAt: null,
        compensationFailureReason: null,
        startedAt: new Date(),
        completedAt: null,
        version: 1,
      }),
    );

    await stepRepository.save(
      stepRepository.create({
        id: randomUUID(),
        sagaId: saga.id,
        stepType: SagaStepType.INVENTORY_RESERVATION,
        status: SagaStepStatus.IN_PROGRESS,
        commandId: correlationId,
        attemptCount: 1,
        lastError: null,
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + this.timeouts.inventoryReservationMs),
        completedAt: null,
      }),
    );
    await stepRepository.save(
      stepRepository.create({
        id: randomUUID(),
        sagaId: saga.id,
        stepType: SagaStepType.PAYMENT_AUTHORIZATION,
        status: SagaStepStatus.PENDING,
        commandId: null,
        attemptCount: 0,
        lastError: null,
        startedAt: null,
        deadlineAt: null,
        completedAt: null,
      }),
    );
    await stepRepository.save(
      stepRepository.create({
        id: randomUUID(),
        sagaId: saga.id,
        stepType: SagaStepType.PAYMENT_RECONCILIATION,
        status: SagaStepStatus.PENDING,
        commandId: null,
        attemptCount: 0,
        lastError: null,
        startedAt: null,
        deadlineAt: null,
        completedAt: null,
      }),
    );
    await stepRepository.save(
      stepRepository.create({
        id: randomUUID(),
        sagaId: saga.id,
        stepType: SagaStepType.PAYMENT_VOID,
        status: SagaStepStatus.PENDING,
        commandId: null,
        attemptCount: 0,
        lastError: null,
        startedAt: null,
        deadlineAt: null,
        completedAt: null,
      }),
    );
    await stepRepository.save(
      stepRepository.create({
        id: randomUUID(),
        sagaId: saga.id,
        stepType: SagaStepType.PAYMENT_REFUND,
        status: SagaStepStatus.PENDING,
        commandId: null,
        attemptCount: 0,
        lastError: null,
        startedAt: null,
        deadlineAt: null,
        completedAt: null,
      }),
    );
    await stepRepository.save(
      stepRepository.create({
        id: randomUUID(),
        sagaId: saga.id,
        stepType: SagaStepType.INVENTORY_RELEASE,
        status: SagaStepStatus.PENDING,
        commandId: null,
        attemptCount: 0,
        lastError: null,
        startedAt: null,
        deadlineAt: null,
        completedAt: null,
      }),
    );
    return saga;
  }
}
