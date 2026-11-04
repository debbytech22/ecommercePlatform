import { ConflictException, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import { OrderEntity, OrderStatus } from '../../entities/order.entity';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaStepEntity } from '../entities/saga-step.entity';
import { SagaState } from '../enums/saga-state.enum';
import { SagaCompensationService } from '../services/saga-compensation.service';
import { CompensationPolicyService } from './compensation-policy.service';
import { CompensationStateValidator } from './compensation-state.validator';
import {
  CompensationReason,
  CompensationStatus,
  type CompensationAction,
} from './compensation.types';
import { OrderStatusHistoryService } from '../../orders/order-status-history.service';

@Injectable()
export class CompensationOrchestratorService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly commands: SagaCompensationService,
    private readonly policy: CompensationPolicyService,
    private readonly stateValidator: CompensationStateValidator,
  ) {}

  async startCompensation(
    orderId: string,
    reason: CompensationReason,
    failureReason: string,
    causationId: string,
  ): Promise<void> {
    if (
      typeof orderId !== 'string' ||
      orderId.trim().length === 0 ||
      orderId.length > 36 ||
      !Object.values(CompensationReason).includes(reason) ||
      typeof failureReason !== 'string' ||
      failureReason.trim().length === 0 ||
      failureReason.length > 1000 ||
      typeof causationId !== 'string' ||
      causationId.trim().length === 0 ||
      causationId.length > 36
    ) {
      throw new ConflictException('Invalid compensation request');
    }

    await this.dataSource.transaction(async (manager) => {
      const saga = await manager
        .getRepository(OrderSagaEntity)
        .createQueryBuilder('saga')
        .setLock('pessimistic_write')
        .where('saga.orderId = :orderId', { orderId })
        .getOne();
      if (!saga) throw new Error(`No Saga exists for order ${orderId}`);

      if (
        saga.currentState === SagaState.COMPENSATING ||
        saga.currentState === SagaState.COMPENSATION_PENDING ||
        saga.currentState === SagaState.COMPENSATED ||
        saga.currentState === SagaState.INVENTORY_RELEASE_PENDING ||
        saga.currentState === SagaState.PAYMENT_VOID_PENDING ||
        saga.currentState === SagaState.PAYMENT_REFUND_PENDING
      ) {
        this.stateValidator.assertSameRequest(saga, reason, causationId);
        return;
      }

      this.stateValidator.assertCanStart(saga);
      const existingSteps = await manager
        .getRepository(SagaStepEntity)
        .findBy({ sagaId: saga.id });
      const actions = this.policy.determineCompensations(
        saga,
        reason,
        existingSteps,
      );
      if (actions.length === 0) {
        throw new ConflictException(
          'Compensation is not required for this Saga outcome',
        );
      }
      saga.currentState = SagaState.COMPENSATING;
      saga.failureCode = reason;
      saga.failureReason = failureReason;
      saga.compensationCausationId = causationId;
      saga.compensationReason = reason;
      saga.compensationStatus = CompensationStatus.REQUIRED;
      saga.compensationStartedAt = new Date();
      saga.compensationCompletedAt = null;
      saga.compensationFailureReason = null;
      saga.completedAt = null;
      await manager.getRepository(OrderSagaEntity).save(saga);

      const order = await manager
        .getRepository(OrderEntity)
        .findOneByOrFail({ id: orderId });
      await OrderStatusHistoryService.transition(
        manager,
        order,
        OrderStatus.CANCELLATION_PENDING,
        {
          reasonCode: reason,
          reason: 'Order compensation started',
          correlationId: saga.correlationId,
          causationId,
        },
      );

      if (
        actions.includes('REFUND_CAPTURE') &&
        actions.includes('RELEASE_INVENTORY')
      ) {
        await this.requestAction(manager, saga, 'REFUND_CAPTURE', causationId);
        await this.requestAction(
          manager,
          saga,
          'RELEASE_INVENTORY',
          causationId,
        );
        return;
      }
      await this.requestAction(manager, saga, actions[0], causationId);
    });
  }

  private async requestAction(
    manager: EntityManager,
    saga: OrderSagaEntity,
    action: CompensationAction,
    causationId: string,
  ): Promise<void> {
    switch (action) {
      case 'VOID_AUTHORIZATION': {
        const authorizationId = saga.paymentAuthorizationId;
        if (!authorizationId) {
          throw new ConflictException(
            `Saga ${saga.id} has no authorization to void`,
          );
        }
        await this.commands.requestPaymentVoid(
          manager,
          saga,
          authorizationId,
          causationId,
        );
        return;
      }
      case 'REFUND_CAPTURE':
        await this.commands.requestPaymentRefund(manager, saga, causationId);
        return;
      case 'RECONCILE_PAYMENT':
        await this.commands.requestPaymentReconciliation(
          manager,
          saga,
          causationId,
        );
        return;
      case 'RELEASE_INVENTORY': {
        const reasonCode = saga.failureCode;
        if (!reasonCode) {
          throw new ConflictException(
            `Saga ${saga.id} has no compensation reason code`,
          );
        }
        await this.commands.requestInventoryRelease(
          manager,
          saga,
          reasonCode,
          causationId,
        );
        return;
      }
    }
  }
}
