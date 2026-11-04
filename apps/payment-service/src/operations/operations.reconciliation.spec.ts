import { jest } from '@jest/globals';
import type { DataSource } from 'typeorm';
import { InboxEventEntity } from '../inbox/entities/inbox-event.entity';
import { OutboxEventEntity } from '../outbox/entities/outbox-event.entity';
import {
  PaymentEntity,
  PaymentStatus,
} from '../payments/entities/payment.entity';
import {
  PaymentOperationEntity,
  PaymentOperationStatus,
  PaymentOperationType,
} from '../payments/entities/payment-operation.entity';
import { PaymentTransactionEntity } from '../payments/entities/payment-transaction.entity';
import type { PaymentProvider } from '../providers/payment-provider.interface';
import { OperationsService } from './operations.service';

describe('OperationsService reconciliation', () => {
  it('resolves an expired operation by status inquiry and commits its result event', async () => {
    const operation = {
      id: 'operation-row-1',
      paymentId: 'payment-1',
      orderId: 'order-1',
      operationId: 'authorization-1',
      authorizationOperationId: null,
      commandId: 'command-1',
      idempotencyKey: 'payment:authorize:authorization-1',
      type: PaymentOperationType.AUTHORIZE,
      status: PaymentOperationStatus.UNKNOWN,
      amount: '25.0000',
      providerReference: null,
      failureCode: 'PROVIDER_OUTCOME_UNKNOWN',
      failureReason: 'Provider outcome requires reconciliation',
      processingLeaseUntil: null,
      reconciliationAttemptCount: 0,
      nextReconciliationAt: new Date(Date.now() - 1000),
      manualInterventionAt: null,
      createdAt: new Date('2026-11-02T10:00:00.000Z'),
    };
    const payment = {
      id: 'payment-1',
      orderId: 'order-1',
      customerId: 'customer-1',
      status: PaymentStatus.REQUIRES_RECONCILIATION,
      currency: 'USD',
      amount: '25.0000',
      authorizedAmount: '0.0000',
      capturedAmount: '0.0000',
      refundedAmount: '0.0000',
    };
    const inbox = {
      eventId: 'command-1',
      correlationId: 'correlation-1',
      status: 'PROCESSING',
      processedAt: null,
    };
    const outboxEvents: Record<string, unknown>[] = [];
    const transactionRows: Record<string, unknown>[] = [];
    const repositories = new Map<Function, object>();

    const operationRepository = {
      createQueryBuilder: () => {
        const builder = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          take: jest.fn().mockReturnThis(),
          setLock: jest.fn().mockReturnThis(),
          setOnLocked: jest.fn().mockReturnThis(),
          getMany: async () => [operation],
          getCount: async () =>
            operation.status === PaymentOperationStatus.UNKNOWN ||
            operation.status === PaymentOperationStatus.REQUIRES_RECONCILIATION
              ? 1
              : 0,
        };
        return builder;
      },
      findOneOrFail: async (options: { where: Record<string, unknown> }) => {
        if (
          options.where.id === operation.id ||
          options.where.operationId === operation.operationId
        ) {
          return operation;
        }
        throw new Error('Operation not found');
      },
      findOne: async () => null,
      save: async (value: typeof operation) => Object.assign(operation, value),
    };
    const paymentRepository = {
      findOneOrFail: async () => payment,
      save: async (value: typeof payment) => Object.assign(payment, value),
    };
    const inboxRepository = {
      findOneOrFail: async () => inbox,
      findOne: async () => inbox,
      save: async (value: typeof inbox) => Object.assign(inbox, value),
    };
    const transactionRepository = {
      findOne: async () => null,
      save: async (value: Record<string, unknown>) => {
        transactionRows.push(value);
        return value;
      },
    };
    const outboxRepository = {
      save: async (value: Record<string, unknown>) => {
        outboxEvents.push(value);
        return value;
      },
    };
    repositories.set(PaymentOperationEntity, operationRepository);
    repositories.set(PaymentEntity, paymentRepository);
    repositories.set(InboxEventEntity, inboxRepository);
    repositories.set(PaymentTransactionEntity, transactionRepository);
    repositories.set(OutboxEventEntity, outboxRepository);

    const manager = {
      getRepository: (entity: Function) => {
        const repository = repositories.get(entity);
        if (!repository) throw new Error('Unexpected repository');
        return repository;
      },
    };
    const dataSource = {
      transaction: async <T>(
        work: (transactionManager: typeof manager) => Promise<T>,
      ) => work(manager),
      getRepository: (entity: Function) => repositories.get(entity),
    } as unknown as DataSource;
    const provider: PaymentProvider = {
      authorize: jest.fn<PaymentProvider['authorize']>(),
      capture: jest.fn<PaymentProvider['capture']>(),
      void: jest.fn<PaymentProvider['void']>(),
      refund: jest.fn<PaymentProvider['refund']>(),
      getTransactionStatus: jest
        .fn<PaymentProvider['getTransactionStatus']>()
        .mockResolvedValue({
          status: 'SUCCEEDED',
          providerReference: 'provider-transaction-1',
          authorizationReference: 'provider-authorization-1',
          failureCode: null,
          failureReason: null,
        }),
    };
    const service = new OperationsService(dataSource, provider);

    await expect(service.reconcilePendingOperations(10, 8)).resolves.toBe(1);

    expect(provider.getTransactionStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'authorization-1',
        idempotencyKey: 'payment:authorize:authorization-1',
      }),
    );
    expect(provider.authorize).not.toHaveBeenCalled();
    expect(operation.status).toBe(PaymentOperationStatus.SUCCEEDED);
    expect(payment.status).toBe(PaymentStatus.AUTHORIZED);
    expect(inbox.status).toBe('PROCESSED');
    expect(outboxEvents[0]).toMatchObject({
      eventType: 'payment.authorized.v1',
      payload: {
        correlationId: 'correlation-1',
        causationId: 'command-1',
        payload: {
          orderId: 'order-1',
          authorizationId: 'provider-authorization-1',
        },
      },
    });
    expect(transactionRows).toHaveLength(1);
  });
});
