import { jest } from '@jest/globals';
import type { DataSource } from 'typeorm';
import { PAYMENT_AUTHORIZE_COMMAND_TYPE } from 'default/contracts';
import { InboxEventEntity } from '../inbox/entities/inbox-event.entity';
import { OutboxEventEntity } from '../outbox/entities/outbox-event.entity';
import { PaymentEntity } from '../payments/entities/payment.entity';
import { PaymentOperationEntity } from '../payments/entities/payment-operation.entity';
import { PaymentTransactionEntity } from '../payments/entities/payment-transaction.entity';
import type { PaymentProvider } from '../providers/payment-provider.interface';
import { OperationsService } from './operations.service';

describe('OperationsService authorization processing', () => {
  it('persists operation before provider response and deduplicates replay', async () => {
    const records = new Map<Function, Array<Record<string, unknown>>>();
    const entityTypes = [
      InboxEventEntity,
      OutboxEventEntity,
      PaymentEntity,
      PaymentOperationEntity,
      PaymentTransactionEntity,
    ];
    for (const entity of entityTypes) records.set(entity, []);

    const repository = (entity: Function) => {
      const rows = records.get(entity)!;
      const matches = (
        row: Record<string, unknown>,
        where: Record<string, unknown> | Array<Record<string, unknown>>,
      ): boolean => {
        const conditions = Array.isArray(where) ? where : [where];
        return conditions.some((condition) =>
          Object.entries(condition).every(([key, value]) => row[key] === value),
        );
      };
      return {
        create: (value: Record<string, unknown>) => ({ ...value }),
        save: async (value: Record<string, unknown>) => {
          const index = rows.findIndex(
            (row) =>
              row.id === value.id ||
              (entity === InboxEventEntity && row.eventId === value.eventId) ||
              (entity === PaymentEntity && row.orderId === value.orderId),
          );
          if (index >= 0) rows[index] = value;
          else rows.push(value);
          return value;
        },
        findOne: async (options: {
          where: Record<string, unknown> | Array<Record<string, unknown>>;
        }) => rows.find((row) => matches(row, options.where)) ?? null,
        findOneBy: async (where: Record<string, unknown>) =>
          rows.find((row) => matches(row, where)) ?? null,
        findOneOrFail: async (options: {
          where: Record<string, unknown> | Array<Record<string, unknown>>;
        }) => {
          const row = rows.find((item) => matches(item, options.where));
          if (!row) throw new Error('Entity not found');
          return row;
        },
        find: async () => rows,
        createQueryBuilder: () => {
          let orderId: unknown;
          return {
            setLock: () => ({
              where: (_condition: string, parameters: { orderId: string }) => {
                orderId = parameters.orderId;
                return {
                  getOne: async () =>
                    rows.find((row) => row.orderId === orderId) ?? null,
                };
              },
            }),
          };
        },
      };
    };

    let providerCalled = false;
    const provider: PaymentProvider = {
      authorize: async (request) => {
        providerCalled = true;
        expect(records.get(PaymentOperationEntity)?.[0].status).toBe(
          'PROCESSING',
        );
        expect(request.idempotencyKey).toContain('operation-1');
        return {
          status: 'SUCCEEDED',
          providerReference: 'provider-txn-1',
          authorizationReference: 'provider-auth-1',
          failureCode: null,
          failureReason: null,
        };
      },
      capture: jest.fn<PaymentProvider['capture']>(),
      void: jest.fn<PaymentProvider['void']>(),
      refund: jest.fn<PaymentProvider['refund']>(),
      getTransactionStatus: jest.fn<PaymentProvider['getTransactionStatus']>(),
    };
    const manager = {
      getRepository: (entity: Function) => repository(entity),
    };
    const dataSource = {
      transaction: async <T>(
        work: (transactionManager: typeof manager) => Promise<T>,
      ) => work(manager),
    } as unknown as DataSource;
    const operations = new OperationsService(dataSource, provider);
    const command = {
      commandId: 'command-1',
      commandType: PAYMENT_AUTHORIZE_COMMAND_TYPE,
      eventVersion: 1,
      aggregateId: 'order-1',
      occurredAt: '2026-11-02T10:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: 'inventory-event-1',
      payload: {
        orderId: 'order-1',
        customerId: 'customer-1',
        paymentOperationId: 'operation-1',
        amount: '25.0000',
        currency: 'USD',
        paymentMethodReference: 'token-reference',
      },
    };

    await expect(operations.process(command)).resolves.toBe('processed');
    expect(providerCalled).toBe(true);
    expect(records.get(PaymentEntity)?.[0]).toMatchObject({
      status: 'AUTHORIZED',
      authorizedAmount: '25.0000',
    });
    expect(records.get(PaymentOperationEntity)?.[0]).toMatchObject({
      status: 'SUCCEEDED',
      providerReference: 'provider-auth-1',
      processingLeaseUntil: null,
    });
    expect(records.get(InboxEventEntity)?.[0].status).toBe('PROCESSED');
    expect(records.get(OutboxEventEntity)?.[0]).toMatchObject({
      eventType: 'payment.authorized.v1',
      payload: {
        causationId: 'command-1',
        correlationId: 'correlation-1',
        payload: {
          paymentId: expect.any(String),
          orderId: 'order-1',
          paymentOperationId: 'operation-1',
          authorizationId: 'provider-auth-1',
          amount: '25.0000',
          currency: 'USD',
        },
      },
    });

    await expect(operations.process(command)).resolves.toBe('duplicate');
    expect(providerCalled).toBe(true);

    await expect(
      operations.process({ ...command, commandId: 'command-retry-1' }),
    ).resolves.toBe('duplicate');
    expect(providerCalled).toBe(true);
    expect(records.get(OutboxEventEntity)).toHaveLength(2);
    expect(records.get(OutboxEventEntity)?.[1]).toMatchObject({
      eventType: 'payment.authorized.v1',
      payload: {
        causationId: 'command-retry-1',
      },
    });
  });

  it('rejects malformed command envelopes before opening a transaction', async () => {
    const transaction = jest.fn();
    const operations = new OperationsService(
      { transaction } as unknown as DataSource,
      {} as PaymentProvider,
    );
    await expect(
      operations.process({ commandType: 'payment.authorize.v1' }),
    ).rejects.toThrow('Payment command envelope or payload is invalid');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a void when the payment has been captured', async () => {
    const payment = {
      id: 'payment-1',
      orderId: 'order-1',
      customerId: 'customer-1',
      status: 'CAPTURED',
      currency: 'USD',
      amount: '25.0000',
      authorizedAmount: '25.0000',
      capturedAmount: '25.0000',
      refundedAmount: '0.0000',
    };
    const authorization = {
      id: 'authorization-row',
      paymentId: payment.id,
      orderId: payment.orderId,
      operationId: 'authorization-operation-1',
      authorizationOperationId: null,
      commandId: 'authorization-command',
      type: 'AUTHORIZE',
      status: 'SUCCEEDED',
      amount: '25.0000',
      providerReference: 'provider-authorization',
    };
    const records = new Map<Function, Array<Record<string, unknown>>>([
      [InboxEventEntity, []],
      [OutboxEventEntity, []],
      [PaymentEntity, [payment]],
      [
        PaymentOperationEntity,
        [
          authorization,
          {
            id: 'capture-row',
            paymentId: payment.id,
            operationId: 'capture-operation-1',
            authorizationOperationId: authorization.operationId,
            type: 'CAPTURE',
            status: 'SUCCEEDED',
            amount: '25.0000',
          },
        ],
      ],
      [PaymentTransactionEntity, []],
    ]);
    const repositories = new Map(
      [...records].map(([entity, rows]) => [
        entity,
        {
          create: (value: Record<string, unknown>) => ({ ...value }),
          save: async (value: Record<string, unknown>) => {
            rows.push(value);
            return value;
          },
          findOne: async (options: {
            where: Record<string, unknown> | Array<Record<string, unknown>>;
          }) => {
            const conditions = Array.isArray(options.where)
              ? options.where
              : [options.where];
            return (
              rows.find((row) =>
                conditions.some((condition) =>
                  Object.entries(condition).every(
                    ([key, value]) => row[key] === value,
                  ),
                ),
              ) ?? null
            );
          },
          findOneBy: async (where: Record<string, unknown>) =>
            rows.find((row) =>
              Object.entries(where).every(([key, value]) => row[key] === value),
            ) ?? null,
          find: async () => rows,
          createQueryBuilder: () => ({
            setLock: () => ({
              where: (_sql: string, parameters: { orderId: string }) => ({
                getOne: async () =>
                  rows.find((row) => row.orderId === parameters.orderId) ??
                  null,
              }),
            }),
          }),
        },
      ]),
    );
    const manager = {
      getRepository: (entity: Function) => repositories.get(entity),
    };
    const provider: PaymentProvider = {
      authorize: jest.fn<PaymentProvider['authorize']>(),
      capture: jest.fn<PaymentProvider['capture']>(),
      void: jest.fn<PaymentProvider['void']>(),
      refund: jest.fn<PaymentProvider['refund']>(),
      getTransactionStatus: jest.fn<PaymentProvider['getTransactionStatus']>(),
    };
    const service = new OperationsService(
      {
        transaction: async <T>(
          work: (transactionManager: typeof manager) => Promise<T>,
        ) => work(manager),
      } as unknown as DataSource,
      provider,
    );

    await expect(
      service.process({
        commandId: 'void-command-1',
        commandType: 'payment.void.v1',
        eventVersion: 1,
        aggregateId: payment.orderId,
        occurredAt: '2026-11-02T10:00:00.000Z',
        correlationId: 'correlation-1',
        causationId: 'order-cancelled-event',
        payload: {
          orderId: payment.orderId,
          sagaId: 'saga-1',
          paymentOperationId: authorization.operationId,
          voidOperationId: 'void-operation-1',
          authorizationId: authorization.providerReference,
          reasonCode: 'ORDER_CANCELLATION',
        },
      }),
    ).rejects.toThrow('Only an uncaptured authorization can be voided');
    expect(provider.void).not.toHaveBeenCalled();
  });

  it('rejects a refund unless a successful capture is persisted', async () => {
    const payment = {
      id: 'payment-1',
      orderId: 'order-1',
      customerId: 'customer-1',
      status: 'AUTHORIZED',
      currency: 'USD',
      amount: '25.0000',
      authorizedAmount: '25.0000',
      capturedAmount: '25.0000',
      refundedAmount: '0.0000',
    };
    const authorization = {
      id: 'authorization-row',
      paymentId: payment.id,
      orderId: payment.orderId,
      operationId: 'authorization-operation-1',
      authorizationOperationId: null,
      commandId: 'authorization-command',
      type: 'AUTHORIZE',
      status: 'SUCCEEDED',
      amount: '25.0000',
      providerReference: 'provider-authorization',
    };
    const records = new Map<Function, Array<Record<string, unknown>>>([
      [InboxEventEntity, []],
      [OutboxEventEntity, []],
      [PaymentEntity, [payment]],
      [PaymentOperationEntity, [authorization]],
      [PaymentTransactionEntity, []],
    ]);
    const repositories = new Map(
      [...records].map(([entity, rows]) => [
        entity,
        {
          create: (value: Record<string, unknown>) => ({ ...value }),
          save: async (value: Record<string, unknown>) => {
            rows.push(value);
            return value;
          },
          findOne: async (options: {
            where: Record<string, unknown> | Array<Record<string, unknown>>;
          }) => {
            const conditions = Array.isArray(options.where)
              ? options.where
              : [options.where];
            return (
              rows.find((row) =>
                conditions.some((condition) =>
                  Object.entries(condition).every(
                    ([key, value]) => row[key] === value,
                  ),
                ),
              ) ?? null
            );
          },
          findOneBy: async (where: Record<string, unknown>) =>
            rows.find((row) =>
              Object.entries(where).every(([key, value]) => row[key] === value),
            ) ?? null,
          find: async () => rows,
          createQueryBuilder: () => ({
            setLock: () => ({
              where: (_sql: string, parameters: { orderId: string }) => ({
                getOne: async () =>
                  rows.find((row) => row.orderId === parameters.orderId) ??
                  null,
              }),
            }),
          }),
        },
      ]),
    );
    const manager = {
      getRepository: (entity: Function) => repositories.get(entity),
    };
    const provider: PaymentProvider = {
      authorize: jest.fn<PaymentProvider['authorize']>(),
      capture: jest.fn<PaymentProvider['capture']>(),
      void: jest.fn<PaymentProvider['void']>(),
      refund: jest.fn<PaymentProvider['refund']>(),
      getTransactionStatus: jest.fn<PaymentProvider['getTransactionStatus']>(),
    };
    const service = new OperationsService(
      {
        transaction: async <T>(
          work: (transactionManager: typeof manager) => Promise<T>,
        ) => work(manager),
      } as unknown as DataSource,
      provider,
    );

    await expect(
      service.process({
        commandId: 'refund-command-1',
        commandType: 'payment.refund.v1',
        eventVersion: 1,
        aggregateId: payment.orderId,
        occurredAt: '2026-11-02T10:00:00.000Z',
        correlationId: 'correlation-1',
        causationId: 'order-cancelled-event',
        payload: {
          orderId: payment.orderId,
          sagaId: 'saga-1',
          paymentOperationId: authorization.operationId,
          refundOperationId: 'refund-operation-1',
          amount: '25.0000',
          currency: 'USD',
          reasonCode: 'ORDER_CANCELLATION',
        },
      }),
    ).rejects.toThrow('A successful capture is required before refunding');
    expect(provider.refund).not.toHaveBeenCalled();
  });
});
