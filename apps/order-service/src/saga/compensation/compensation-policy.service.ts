import { ConflictException, Injectable } from '@nestjs/common';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaState } from '../enums/saga-state.enum';
import { SagaStepStatus } from '../enums/saga-step-status.enum';
import { SagaStepEntity, SagaStepType } from '../entities/saga-step.entity';
import { CompensationAction, CompensationReason } from './compensation.types';

@Injectable()
export class CompensationPolicyService {
  determineCompensations(
    saga: OrderSagaEntity,
    reason: CompensationReason,
    existingSteps: Pick<
      SagaStepEntity,
      'stepType' | 'status'
    >[] = Array.isArray(saga.steps) ? saga.steps : [],
  ): CompensationAction[] {
    if (reason === CompensationReason.INVENTORY_RESERVATION_FAILED) return [];
    if (
      ![
        SagaState.INVENTORY_RESERVED,
        SagaState.PAYMENT_PENDING,
        SagaState.PAYMENT_AUTHORIZED,
        SagaState.CONFIRMATION_PENDING,
        SagaState.COMPLETED,
        SagaState.COMPENSATION_REQUIRED,
      ].includes(saga.currentState)
    ) {
      throw new ConflictException(
        `Saga ${saga.id} cannot determine compensation from ${saga.currentState}`,
      );
    }

    const actions: CompensationAction[] = [];

    if (saga.paymentStatus === 'AUTHORIZED') {
      if (!saga.paymentOperationId || !saga.paymentAuthorizationId) {
        throw new ConflictException(
          'Authorization compensation requires its persisted operation and authorization IDs',
        );
      }
      if (
        this.getActionStatus(existingSteps, SagaStepType.PAYMENT_VOID) ===
        SagaStepStatus.IN_PROGRESS
      ) {
        return actions;
      }
      if (!this.isActionOutstanding(existingSteps, SagaStepType.PAYMENT_VOID)) {
        actions.push('VOID_AUTHORIZATION');
      }
    } else if (saga.paymentStatus === 'CAPTURED') {
      if (!saga.paymentOperationId) {
        throw new ConflictException(
          'Capture compensation requires its persisted payment operation ID',
        );
      }
      if (
        this.getActionStatus(existingSteps, SagaStepType.PAYMENT_REFUND) ===
        SagaStepStatus.IN_PROGRESS
      ) {
        return actions;
      }
      if (
        !this.isActionOutstanding(existingSteps, SagaStepType.PAYMENT_REFUND)
      ) {
        actions.push('REFUND_CAPTURE');
      }
    } else if (saga.paymentOperationId) {
      if (reason === CompensationReason.PAYMENT_AUTHORIZATION_FAILED) {
        // A definitive authorization failure has no successful payment to compensate.
      } else if (
        reason === CompensationReason.PAYMENT_CAPTURE_FAILED &&
        saga.paymentAuthorizationId
      ) {
        if (!saga.paymentOperationId) {
          throw new ConflictException(
            'Authorization void requires its persisted payment operation ID',
          );
        }
        if (
          this.getActionStatus(existingSteps, SagaStepType.PAYMENT_VOID) ===
          SagaStepStatus.IN_PROGRESS
        ) {
          return actions;
        }
        if (
          !this.isActionOutstanding(existingSteps, SagaStepType.PAYMENT_VOID)
        ) {
          actions.push('VOID_AUTHORIZATION');
        }
      } else {
        if (
          !this.isActionOutstanding(
            existingSteps,
            SagaStepType.PAYMENT_RECONCILIATION,
          )
        ) {
          actions.push('RECONCILE_PAYMENT');
        }
        return actions;
      }
    }

    if (
      saga.inventoryReservationId &&
      saga.inventoryReservationStatus === 'RESERVED' &&
      !this.isActionOutstanding(existingSteps, SagaStepType.INVENTORY_RELEASE)
    ) {
      actions.push('RELEASE_INVENTORY');
    }

    return actions;
  }

  private isActionOutstanding(
    existingSteps: Pick<SagaStepEntity, 'stepType' | 'status'>[],
    stepType: SagaStepType,
  ): boolean {
    const status = this.getActionStatus(existingSteps, stepType);
    return (
      status === SagaStepStatus.IN_PROGRESS ||
      status === SagaStepStatus.SUCCEEDED ||
      status === SagaStepStatus.COMPENSATED
    );
  }

  private getActionStatus(
    existingSteps: Pick<SagaStepEntity, 'stepType' | 'status'>[],
    stepType: SagaStepType,
  ): SagaStepStatus | undefined {
    return existingSteps.find((step) => step.stepType === stepType)?.status;
  }
}
