import { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { OrderSagaEntity } from '../entities/order-saga.entity';
import { SagaStepEntity, SagaStepType } from '../entities/saga-step.entity';
import { SagaState } from '../enums/saga-state.enum';
import { SagaStepStatus } from '../enums/saga-step-status.enum';
import { SagaCompensationService } from './saga-compensation.service';
import { SagaRecoveryService } from './saga-recovery.service';
import { OrderConfirmationMetricsService } from '../confirmation/order-confirmation-metrics.service';
import { OrderQueryMetricsService } from '../../orders/queries/order-query-metrics.service';
import { loadSagaTimeoutConfig } from '../config/saga-timeout.config';

function createRecoveryHarness(
  overdueStep: Record<string, unknown>,
  reconciliationStep: Record<string, unknown> | null = null,
) {
  const saga = {
    id: 'saga-1',
    orderId: '00000000-0000-4000-8000-000000000001',
    currentState: SagaState.MANUAL_INTERVENTION_REQUIRED,
    paymentOperationId: 'payment-operation-1',
    correlationId: 'correlation-1',
  };
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];
  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    isTransactionActive: true,
    manager: {
      getRepository: jest.fn((entity: Function) => {
        if (entity === OrderSagaEntity) {
          return {
            findOneByOrFail: jest.fn().mockResolvedValue(saga),
          };
        }
        if (entity === SagaStepEntity) {
          return {
            findOneByOrFail: jest.fn().mockResolvedValue(reconciliationStep),
          };
        }
        throw new Error('Unexpected repository');
      }),
    },
    query: jest.fn(async (sql: string, parameters: unknown[] = []) => {
      queries.push({ sql, parameters });
      if (sql.includes('SELECT step.`id` AS `step_id`')) {
        return [overdueStep];
      }
      if (sql.includes('SELECT `status` FROM `orders`')) {
        return [{ status: 'PROCESSING_PAYMENT' }];
      }
      if (sql.includes('MAX(`sequence_number`)')) {
        return [{ next_sequence: 2 }];
      }
      if (sql.includes('SELECT `event_id` FROM `order_inbox_events`')) {
        return [];
      }
      if (sql.includes('SELECT `id`, `event_type`, `published_at`')) {
        return [
          {
            id: 'outbox-command-event',
            event_type: 'payment.authorize.v1',
            published_at: new Date(),
            failed_at: null,
          },
        ];
      }
      return { affectedRows: 1 };
    }),
  };
  const dataSource = {
    createQueryRunner: jest.fn(() => runner),
  } as unknown as DataSource;
  const compensation = {
    requestPaymentReconciliation: jest
      .fn<
        (
          manager: EntityManager,
          saga: OrderSagaEntity,
          causation: string,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined),
  } as unknown as SagaCompensationService;
  const service = new SagaRecoveryService(
    {} as never,
    dataSource,
    compensation,
    new ConfigService(),
    new OrderConfirmationMetricsService(),
    new OrderQueryMetricsService(),
    loadSagaTimeoutConfig(process.env),
  );
  return { service, runner, queries, saga, compensation };
}

describe('SagaRecoveryService', () => {
  it('reconciles an authorization timeout instead of retrying authorization', async () => {
    const harness = createRecoveryHarness(
      {
        step_id: 'payment-step-1',
        saga_id: 'saga-1',
        order_id: '00000000-0000-4000-8000-000000000001',
        state: SagaState.PAYMENT_PENDING,
        step_type: SagaStepType.PAYMENT_AUTHORIZATION,
        command_id: 'authorize-command-1',
        attempts: 1,
        correlation_id: 'correlation-1',
        payment_operation_id: 'payment-operation-1',
        failure_code: null,
      },
      {
        id: 'reconciliation-step-1',
        sagaId: 'saga-1',
        stepType: SagaStepType.PAYMENT_RECONCILIATION,
        commandId: null,
        status: SagaStepStatus.PENDING,
      },
    );

    await harness.service.recoverOverdueSteps();

    expect(
      harness.compensation.requestPaymentReconciliation,
    ).toHaveBeenCalledWith(
      harness.runner.manager,
      harness.saga,
      'outbox-command-event',
    );
    expect(
      harness.queries.some(({ sql }) =>
        sql.includes("'PAYMENT_AUTHORIZATION_TIMEOUT'"),
      ),
    ).toBe(true);
    expect(
      harness.queries.some(({ sql }) =>
        sql.includes('SET `published_at` = NULL'),
      ),
    ).toBe(false);
    expect(harness.runner.commitTransaction).toHaveBeenCalled();
  });

  it('replays a published inventory command with the original event ID', async () => {
    const harness = createRecoveryHarness({
      step_id: 'inventory-step-1',
      saga_id: 'saga-1',
      order_id: '00000000-0000-4000-8000-000000000001',
      state: SagaState.INVENTORY_RESERVATION_PENDING,
      step_type: SagaStepType.INVENTORY_RESERVATION,
      command_id: 'correlation-1',
      attempts: 1,
      correlation_id: 'correlation-1',
      payment_operation_id: null,
      failure_code: null,
    });

    await harness.service.recoverOverdueSteps();

    expect(harness.queries).toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining('SET `published_at` = NULL'),
        parameters: ['outbox-command-event'],
      }),
    );
    expect(harness.queries).toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining('SET `attempts` = `attempts` + 1'),
        parameters: expect.arrayContaining(['inventory-step-1']),
      }),
    );
    expect(harness.runner.commitTransaction).toHaveBeenCalled();
  });
});
