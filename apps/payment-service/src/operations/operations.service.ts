import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import {
  PAYMENT_AUTHORIZE_COMMAND_TYPE,
  PAYMENT_AUTHORIZED_EVENT_TYPE,
  PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE,
  PAYMENT_CAPTURE_COMMAND_TYPE,
  PAYMENT_CAPTURED_EVENT_TYPE,
  PAYMENT_CAPTURE_FAILED_EVENT_TYPE,
  PAYMENT_REFUND_COMMAND_TYPE,
  PAYMENT_REFUNDED_EVENT_TYPE,
  PAYMENT_REFUND_FAILED_EVENT_TYPE,
  PAYMENT_VOID_COMMAND_TYPE,
  PAYMENT_VOIDED_EVENT_TYPE,
  PAYMENT_VOID_FAILED_EVENT_TYPE,
} from 'default/contracts';
import {
  InboxEventEntity,
  InboxEventStatus,
} from '../inbox/entities/inbox-event.entity';
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
import {
  assertCanCapture,
  assertCanRefund,
  assertPaymentTransition,
  assertPositivePaymentAmount,
  toMinorUnits,
} from '../payments/payment-state-machine';
import { assertOperationTransition } from '../payments/operation-state-machine';
import {
  PAYMENT_PROVIDER,
  PaymentProviderError,
  type PaymentProvider,
  type PaymentProviderRequest,
  type PaymentProviderResult,
  parsePaymentProviderResult,
} from '../providers/payment-provider.interface';
import { ProviderStatusService } from '../reconciliation/provider-status.service';

const PROCESSING_LEASE_MS = 60_000;
const RECONCILIATION_LEASE_MS = 60_000;
const RECONCILIATION_RETRY_BASE_MS = 30_000;
const RECONCILIATION_RETRY_MAX_MS = 3_600_000;

const operationCommands = {
  [PAYMENT_AUTHORIZE_COMMAND_TYPE]: PaymentOperationType.AUTHORIZE,
  [PAYMENT_CAPTURE_COMMAND_TYPE]: PaymentOperationType.CAPTURE,
  [PAYMENT_VOID_COMMAND_TYPE]: PaymentOperationType.VOID,
  [PAYMENT_REFUND_COMMAND_TYPE]: PaymentOperationType.REFUND,
} as const;

type SupportedCommandType = keyof typeof operationCommands;

interface PaymentCommandRecord {
  commandId: string;
  commandType: SupportedCommandType;
  eventVersion: number;
  aggregateId: string;
  occurredAt: string;
  correlationId: string;
  causationId: string | null;
  payload: Record<string, unknown>;
}

interface PreparedOperation {
  duplicate: boolean;
  recoverExistingOperation: boolean;
  payment: PaymentEntity;
  operation: PaymentOperationEntity;
  providerRequest: PaymentProviderRequest;
}

interface PreparedReconciliation extends PreparedOperation {
  command: PaymentCommandRecord;
}

export class PaymentCommandValidationError extends BadRequestException {
  constructor(message = 'Payment command envelope or payload is invalid') {
    super(message);
    this.name = 'PaymentCommandValidationError';
  }
}

export class PaymentCommandBusyError extends Error {
  constructor(commandId: string) {
    super(`Payment command ${commandId} is being processed`);
    this.name = 'PaymentCommandBusyError';
  }
}

export class PaymentOutcomeUncertainError extends Error {
  constructor(operationId: string) {
    super(`Payment operation ${operationId} requires provider reconciliation`);
    this.name = 'PaymentOutcomeUncertainError';
  }
}

@Injectable()
export class OperationsService {
  private readonly logger = new Logger(OperationsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(PAYMENT_PROVIDER)
    private readonly provider: PaymentProvider,
    private readonly providerStatus: ProviderStatusService,
  ) {}

  async getCompensationMetrics(): Promise<string> {
    const operationRows = (await this.dataSource.query(
      "SELECT `operation_type`, `operation_status`, COUNT(*) AS `operation_count` FROM `payment_operations` WHERE `operation_type` IN ('VOID', 'REFUND') GROUP BY `operation_type`, `operation_status`",
    )) as Array<{
      operation_type: PaymentOperationType;
      operation_status: PaymentOperationStatus;
      operation_count: number | string;
    }>;
    const [backlog] = (await this.dataSource.query(
      "SELECT COUNT(*) AS `unresolved_operations` FROM `payment_operations` WHERE `operation_status` IN ('PENDING', 'PROCESSING', 'UNKNOWN', 'REQUIRES_RECONCILIATION')",
    )) as Array<{ unresolved_operations: number | string }>;
    const durationRows = (await this.dataSource.query(
      "SELECT `operation_type`, COALESCE(AVG(TIMESTAMPDIFF(MICROSECOND, `created_at`, `updated_at`)) / 1000000, 0) AS `duration_seconds` FROM `payment_operations` WHERE `operation_type` IN ('VOID', 'REFUND') AND `operation_status` IN ('SUCCEEDED', 'FAILED') GROUP BY `operation_type`",
    )) as Array<{
      operation_type: PaymentOperationType;
      duration_seconds: number | string;
    }>;

    return [
      '# HELP payment_compensation_operations Number of durable void and refund operations by state.',
      '# TYPE payment_compensation_operations gauge',
      ...operationRows.map(
        ({ operation_type, operation_status, operation_count }) =>
          `payment_compensation_operations{operation_type="${operation_type}",status="${operation_status}"} ${Number(operation_count)}`,
      ),
      '# HELP payment_unresolved_provider_operations Payment operations with an unresolved provider outcome.',
      '# TYPE payment_unresolved_provider_operations gauge',
      `payment_unresolved_provider_operations ${Number(backlog.unresolved_operations)}`,
      '# HELP payment_compensation_operation_duration_seconds Average provider-operation persistence duration.',
      '# TYPE payment_compensation_operation_duration_seconds gauge',
      ...durationRows.map(
        ({ operation_type, duration_seconds }) =>
          `payment_compensation_operation_duration_seconds{operation_type="${operation_type}"} ${Number(duration_seconds)}`,
      ),
      '',
    ].join('\n');
  }

  async process(command: unknown): Promise<'processed' | 'duplicate'> {
    const validated = this.validateCommand(command);
    const prepared = await this.withTransaction((manager) =>
      this.prepareOperation(manager, validated),
    );

    if (prepared.duplicate) {
      this.logger.warn(
        JSON.stringify({
          event: 'payment.command.duplicate_ignored',
          commandId: validated.commandId,
          commandType: validated.commandType,
          orderId: validated.aggregateId,
          sagaId: validated.payload.sagaId ?? null,
          compensationStepId:
            prepared.operation.type === PaymentOperationType.VOID ||
            prepared.operation.type === PaymentOperationType.REFUND
              ? prepared.operation.operationId
              : null,
          correlationId: validated.correlationId,
        }),
      );
      return 'duplicate';
    }

    let providerResult: PaymentProviderResult;
    const providerStartedAt = Date.now();
    try {
      if (prepared.recoverExistingOperation) {
        const status = parsePaymentProviderResult(
          await this.provider.getTransactionStatus(prepared.providerRequest),
        );
        if (status.status === 'SUCCEEDED' || status.status === 'DECLINED') {
          providerResult = status;
        } else {
          providerResult = status;
        }
      } else {
        providerResult = parsePaymentProviderResult(
          await this.invokeProvider(
            prepared.operation.type,
            prepared.providerRequest,
          ),
        );
      }
    } catch (error) {
      if (error instanceof PaymentProviderError && error.kind === 'DECLINED') {
        this.logProviderMetric(
          prepared.operation.type,
          'DECLINED',
          Date.now() - providerStartedAt,
          validated.correlationId,
          this.operationLogContext(validated, prepared.operation),
        );
        providerResult = {
          status: 'DECLINED',
          providerReference: null,
          authorizationReference: null,
          failureCode: 'PAYMENT_DECLINED',
          failureReason: null,
        };
        await this.persistProviderResult(validated, prepared, providerResult);
        return 'processed';
      }
      if (
        error instanceof PaymentProviderError &&
        error.kind === 'AUTHENTICATION'
      ) {
        this.logProviderMetric(
          prepared.operation.type,
          'AUTHENTICATION_ERROR',
          Date.now() - providerStartedAt,
          validated.correlationId,
          this.operationLogContext(validated, prepared.operation),
        );
        await this.persistManualIntervention(
          validated,
          prepared,
          'PROVIDER_AUTHENTICATION_FAILED',
        );
        return 'processed';
      }
      this.logProviderMetric(
        prepared.operation.type,
        'OUTCOME_UNKNOWN',
        Date.now() - providerStartedAt,
        validated.correlationId,
        this.operationLogContext(validated, prepared.operation),
      );
      await this.persistUncertainOutcome(
        validated,
        prepared,
        this.toStableFailureCode(error),
      );
      throw new PaymentOutcomeUncertainError(prepared.operation.operationId);
    }

    this.logProviderMetric(
      prepared.operation.type,
      providerResult.status,
      Date.now() - providerStartedAt,
      validated.correlationId,
      this.operationLogContext(validated, prepared.operation),
    );
    await this.persistProviderResult(validated, prepared, providerResult);

    if (
      providerResult.status === 'UNKNOWN' ||
      providerResult.status === 'PROCESSING'
    ) {
      throw new PaymentOutcomeUncertainError(prepared.operation.operationId);
    }

    this.logger.log(
      JSON.stringify({
        event: 'payment.operation.processed',
        commandId: validated.commandId,
        commandType: validated.commandType,
        orderId: validated.aggregateId,
        operationId: prepared.operation.operationId,
        operationType: prepared.operation.type,
        outcome: providerResult.status,
        sagaId: validated.payload.sagaId ?? null,
        compensationStepId:
          prepared.operation.type === PaymentOperationType.VOID ||
          prepared.operation.type === PaymentOperationType.REFUND
            ? prepared.operation.operationId
            : null,
        correlationId: validated.correlationId,
        causationId: validated.causationId,
      }),
    );
    return 'processed';
  }

  async reconcilePendingOperations(
    batchSize: number,
    maxAttempts: number,
    alertBacklogThreshold = 100,
  ): Promise<number> {
    const now = new Date();
    const claimed = await this.withTransaction(async (manager) => {
      const operations = manager.getRepository(PaymentOperationEntity);
      const due = await operations
        .createQueryBuilder('operation')
        .where(
          '((operation.status IN (:...reconciliationStatuses) AND (operation.nextReconciliationAt IS NULL OR operation.nextReconciliationAt <= :now)) OR (operation.status = :processingStatus AND operation.processingLeaseUntil <= :now))',
          {
            reconciliationStatuses: [
              PaymentOperationStatus.UNKNOWN,
              PaymentOperationStatus.REQUIRES_RECONCILIATION,
            ],
            processingStatus: PaymentOperationStatus.PROCESSING,
            now,
          },
        )
        .andWhere(
          '(operation.processingLeaseUntil IS NULL OR operation.processingLeaseUntil <= :now)',
          { now },
        )
        .orderBy('operation.nextReconciliationAt', 'ASC')
        .take(batchSize)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();
      for (const operation of due) {
        operation.processingLeaseUntil = new Date(
          now.getTime() + RECONCILIATION_LEASE_MS,
        );
        await operations.save(operation);
      }
      return due;
    });

    for (const operation of claimed) {
      const reconciliationStartedAt = Date.now();
      try {
        const prepared = await this.prepareReconciliation(operation.id);
        const result = parsePaymentProviderResult(
          await this.provider.getTransactionStatus(prepared.providerRequest),
        );
        this.logProviderMetric(
          operation.type,
          result.status,
          Date.now() - reconciliationStartedAt,
          prepared.command.correlationId,
          this.operationLogContext(prepared.command, operation),
        );
        if (result.status === 'SUCCEEDED' || result.status === 'DECLINED') {
          await this.persistProviderResult(prepared.command, prepared, result);
          await this.providerStatus.recordAttempt(
            operation.operationId,
            operation.reconciliationAttemptCount + 1,
            result,
            null,
          );
          this.logger.log(
            JSON.stringify({
              event: 'payment.reconciliation.resolved',
              operationId: operation.operationId,
              orderId: operation.orderId,
              outcome: result.status,
              correlationId: prepared.command.correlationId,
            }),
          );
        } else {
          await this.providerStatus.recordAttempt(
            operation.operationId,
            operation.reconciliationAttemptCount + 1,
            result,
            null,
          );
          await this.recordReconciliationAttempt(
            operation.id,
            maxAttempts,
            result.failureCode ?? 'PROVIDER_OUTCOME_PENDING',
          );
        }
      } catch (error) {
        await this.providerStatus.recordAttempt(
          operation.operationId,
          operation.reconciliationAttemptCount + 1,
          null,
          error,
        );
        if (
          error instanceof PaymentProviderError &&
          error.kind === 'AUTHENTICATION'
        ) {
          await this.escalateOperation(
            operation.id,
            'PROVIDER_AUTHENTICATION_FAILED',
          );
        } else {
          await this.recordReconciliationAttempt(
            operation.id,
            maxAttempts,
            this.toStableFailureCode(error),
          );
        }
        this.logger.error(
          JSON.stringify({
            event: 'payment.reconciliation.query_failed',
            operationId: operation.operationId,
            orderId: operation.orderId,
            failureCode: this.toStableFailureCode(error),
          }),
        );
      }
    }

    const backlog = await this.dataSource
      .getRepository(PaymentOperationEntity)
      .createQueryBuilder('operation')
      .where('operation.status IN (:...statuses)', {
        statuses: [
          PaymentOperationStatus.UNKNOWN,
          PaymentOperationStatus.REQUIRES_RECONCILIATION,
        ],
      })
      .getCount();
    this.logger.log(
      JSON.stringify({
        event: 'payment.metric',
        metric: 'payment_reconciliation_backlog',
        value: backlog,
        claimed: claimed.length,
      }),
    );
    if (backlog >= alertBacklogThreshold) {
      this.logger.error(
        JSON.stringify({
          event: 'payment.reconciliation.backlog_alert',
          backlog,
          threshold: alertBacklogThreshold,
          alert: true,
        }),
      );
    }

    return claimed.length;
  }

  private async prepareOperation(
    manager: EntityManager,
    command: PaymentCommandRecord,
  ): Promise<PreparedOperation> {
    const inboxRepository = manager.getRepository(InboxEventEntity);
    let inbox = await inboxRepository.findOne({
      where: { eventId: command.commandId },
      lock: { mode: 'pessimistic_write' },
    });

    if (inbox) {
      if (
        inbox.eventType !== command.commandType ||
        inbox.aggregateId !== command.aggregateId ||
        inbox.correlationId !== command.correlationId
      ) {
        throw new ConflictException(
          'Payment command ID was reused with different envelope metadata',
        );
      }
      if (inbox.status === InboxEventStatus.PROCESSED) {
        return this.duplicateOperation(manager, command);
      }
      if (inbox.status === InboxEventStatus.FAILED) {
        throw new ConflictException('Payment command previously failed');
      }
    } else {
      inbox = inboxRepository.create({
        id: randomUUID(),
        eventId: command.commandId,
        eventType: command.commandType,
        aggregateId: command.aggregateId,
        correlationId: command.correlationId,
        status: InboxEventStatus.PROCESSING,
        processedAt: null,
      });
      await inboxRepository.save(inbox);
    }

    const type = operationCommands[command.commandType];
    const operationId = this.operationId(command);
    const rawAmount =
      type === PaymentOperationType.AUTHORIZE
        ? this.requiredString(command.payload, 'amount')
        : type === PaymentOperationType.VOID
          ? null
          : this.requiredString(command.payload, 'amount');
    const requestedAmount = rawAmount ? this.canonicalAmount(rawAmount) : null;
    const currency =
      type === PaymentOperationType.AUTHORIZE
        ? this.requiredString(command.payload, 'currency')
        : type === PaymentOperationType.VOID
          ? null
          : this.requiredString(command.payload, 'currency');
    const paymentRepository = manager.getRepository(PaymentEntity);
    let payment = await paymentRepository
      .createQueryBuilder('payment')
      .setLock('pessimistic_write')
      .where('payment.orderId = :orderId', {
        orderId: command.aggregateId,
      })
      .getOne();

    if (type === PaymentOperationType.AUTHORIZE && !payment) {
      payment = paymentRepository.create({
        id: randomUUID(),
        orderId: command.aggregateId,
        customerId: this.requiredString(command.payload, 'customerId'),
        status: PaymentStatus.PENDING,
        amount: requestedAmount!,
        currency: currency!,
        authorizedAmount: '0.0000',
        capturedAmount: '0.0000',
        refundedAmount: '0.0000',
      });
      this.validateAmountAndCurrency(payment.amount, payment.currency);
      await paymentRepository.save(payment);
    }

    if (!payment) {
      throw new ConflictException('Payment does not exist for this order');
    }
    if (payment.orderId !== command.aggregateId) {
      throw new ConflictException('Payment order identifier does not match');
    }
    if (type === PaymentOperationType.AUTHORIZE) {
      if (
        payment.amount !== requestedAmount ||
        payment.currency !== currency ||
        payment.customerId !==
          this.requiredString(command.payload, 'customerId')
      ) {
        throw new ConflictException(
          'Authorization command does not match the persisted payment',
        );
      }
    } else if (type !== PaymentOperationType.VOID) {
      this.validateAmountAndCurrency(requestedAmount!, currency!);
      if (payment.currency !== currency) {
        throw new ConflictException(
          'Payment command currency does not match the payment',
        );
      }
    }

    const operations = manager.getRepository(PaymentOperationEntity);
    const authorizationOperationId =
      type === PaymentOperationType.AUTHORIZE
        ? null
        : this.requiredIdentifier(command.payload, 'paymentOperationId');
    const authorizationOperation = authorizationOperationId
      ? await operations.findOne({
          where: {
            paymentId: payment.id,
            operationId: authorizationOperationId,
            type: PaymentOperationType.AUTHORIZE,
            status: PaymentOperationStatus.SUCCEEDED,
          },
        })
      : null;
    let operation = await operations.findOne({
      where: [{ operationId }, { commandId: command.commandId }],
      lock: { mode: 'pessimistic_write' },
    });
    const recoverExistingOperation = operation !== null;

    if (operation) {
      if (
        operation.operationId !== operationId ||
        operation.paymentId !== payment.id ||
        operation.type !== type ||
        operation.orderId !== command.aggregateId ||
        operation.amount !== requestedAmount ||
        operation.authorizationOperationId !== authorizationOperationId
      ) {
        throw new ConflictException(
          'Payment operation ID was reused with different command data',
        );
      }
      if (
        operation.status === PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED
      ) {
        inbox.status = InboxEventStatus.PROCESSED;
        inbox.processedAt = new Date();
        await inboxRepository.save(inbox);
        return {
          duplicate: true,
          recoverExistingOperation: false,
          payment,
          operation,
          providerRequest: this.createProviderRequest(
            command,
            operation,
            payment,
            null,
          ),
        };
      }
      if (operation.status === PaymentOperationStatus.FAILED) {
        inbox.status = InboxEventStatus.PROCESSED;
        inbox.processedAt = new Date();
        await inboxRepository.save(inbox);
        await this.createResultEvent(manager, command, payment, operation, {
          status: 'DECLINED',
          providerReference: operation.providerReference,
          authorizationReference:
            type === PaymentOperationType.AUTHORIZE
              ? operation.providerReference
              : null,
          failureCode: operation.failureCode,
          failureReason: operation.failureReason,
        });
        return {
          duplicate: true,
          recoverExistingOperation: false,
          payment,
          operation,
          providerRequest: this.createProviderRequest(
            command,
            operation,
            payment,
            authorizationOperation?.providerReference ?? null,
          ),
        };
      }
      if (operation.status === PaymentOperationStatus.SUCCEEDED) {
        inbox.status = InboxEventStatus.PROCESSED;
        inbox.processedAt = new Date();
        await inboxRepository.save(inbox);
        await this.createResultEvent(manager, command, payment, operation, {
          status: 'SUCCEEDED',
          providerReference: operation.providerReference,
          authorizationReference:
            type === PaymentOperationType.AUTHORIZE
              ? operation.providerReference
              : null,
          failureCode: null,
          failureReason: null,
        });
        return {
          duplicate: true,
          recoverExistingOperation: false,
          payment,
          operation,
          providerRequest: this.createProviderRequest(
            command,
            operation,
            payment,
            authorizationOperation?.providerReference ?? null,
          ),
        };
      }
      if (
        operation.processingLeaseUntil &&
        operation.processingLeaseUntil.getTime() > Date.now()
      ) {
        throw new PaymentCommandBusyError(command.commandId);
      }
      assertOperationTransition(
        operation.status,
        PaymentOperationStatus.PROCESSING,
      );
      operation.status = PaymentOperationStatus.PROCESSING;
      operation.processingLeaseUntil = new Date(
        Date.now() + PROCESSING_LEASE_MS,
      );
      await operations.save(operation);
    } else {
      if (type === PaymentOperationType.AUTHORIZE) {
        const priorAuthorization = await operations.findOne({
          where: {
            paymentId: payment.id,
            type: PaymentOperationType.AUTHORIZE,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (priorAuthorization) {
          throw new ConflictException(
            'An authorization operation already exists for this order',
          );
        }
        if (
          payment.status !== PaymentStatus.PENDING &&
          payment.status !== PaymentStatus.FAILED
        ) {
          throw new ConflictException(
            `Payment in ${payment.status} state cannot be authorized`,
          );
        }
      } else {
        await this.validateOperationPreconditions(
          manager,
          payment,
          command,
          type,
          requestedAmount!,
        );
      }

      operation = operations.create({
        id: randomUUID(),
        paymentId: payment.id,
        orderId: payment.orderId,
        operationId,
        authorizationOperationId,
        commandId: command.commandId,
        idempotencyKey: `payment:${type.toLowerCase()}:${operationId}`,
        type,
        status: PaymentOperationStatus.PENDING,
        amount: requestedAmount,
        providerReference: null,
        failureCode: null,
        failureReason: null,
        processingLeaseUntil: new Date(Date.now() + PROCESSING_LEASE_MS),
      });
      assertOperationTransition(
        operation.status,
        PaymentOperationStatus.PROCESSING,
      );
      operation.status = PaymentOperationStatus.PROCESSING;
      await operations.save(operation);
    }

    return {
      duplicate: false,
      recoverExistingOperation,
      payment,
      operation,
      providerRequest: this.createProviderRequest(
        command,
        operation,
        payment,
        authorizationOperation?.providerReference ?? null,
        await this.getCapturedProviderReference(manager, payment, type),
      ),
    };
  }

  private async duplicateOperation(
    manager: EntityManager,
    command: PaymentCommandRecord,
  ): Promise<PreparedOperation> {
    const operation = await manager
      .getRepository(PaymentOperationEntity)
      .findOneBy({ commandId: command.commandId });
    const payment = operation
      ? await manager
          .getRepository(PaymentEntity)
          .findOneBy({ id: operation.paymentId })
      : null;
    if (!operation || !payment) {
      throw new ConflictException(
        'Processed Inbox command has no persisted payment operation',
      );
    }
    return {
      duplicate: true,
      recoverExistingOperation: false,
      payment,
      operation,
      providerRequest: this.createProviderRequest(
        command,
        operation,
        payment,
        null,
      ),
    };
  }

  private async validateOperationPreconditions(
    manager: EntityManager,
    payment: PaymentEntity,
    command: PaymentCommandRecord,
    type: PaymentOperationType,
    amount: string,
  ): Promise<void> {
    const operations = manager.getRepository(PaymentOperationEntity);
    const authorizationId = this.requiredString(
      command.payload,
      'paymentOperationId',
    );
    const authorization = await operations.findOne({
      where: {
        paymentId: payment.id,
        operationId: authorizationId,
        type: PaymentOperationType.AUTHORIZE,
        status: PaymentOperationStatus.SUCCEEDED,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!authorization) {
      throw new ConflictException(
        'A successful payment authorization is required',
      );
    }
    if (payment.status === PaymentStatus.REQUIRES_RECONCILIATION) {
      throw new ConflictException(
        'Payment has an unresolved operation and requires reconciliation',
      );
    }

    if (type === PaymentOperationType.CAPTURE) {
      const voidOperation = await operations.findOne({
        where: [
          {
            paymentId: payment.id,
            type: PaymentOperationType.VOID,
            status: PaymentOperationStatus.PROCESSING,
          },
          {
            paymentId: payment.id,
            type: PaymentOperationType.VOID,
            status: PaymentOperationStatus.UNKNOWN,
          },
        ],
        lock: { mode: 'pessimistic_write' },
      });
      if (voidOperation) {
        throw new ConflictException(
          'Payment cannot be captured while a void is pending',
        );
      }
      assertCanCapture(
        payment.status,
        payment.authorizedAmount,
        payment.capturedAmount,
        amount,
      );
      this.assertNoConflictingOperations(
        await operations.find({
          where: {
            paymentId: payment.id,
            type: PaymentOperationType.CAPTURE,
          },
          lock: { mode: 'pessimistic_write' },
        }),
        payment.capturedAmount,
        amount,
        payment.authorizedAmount,
      );
    } else if (type === PaymentOperationType.REFUND) {
      const capture = await operations.findOne({
        where: {
          paymentId: payment.id,
          authorizationOperationId: authorization.operationId,
          type: PaymentOperationType.CAPTURE,
          status: PaymentOperationStatus.SUCCEEDED,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!capture) {
        throw new ConflictException(
          'A successful capture is required before refunding',
        );
      }
      assertCanRefund(payment.capturedAmount, payment.refundedAmount, amount);
      this.assertNoConflictingOperations(
        await operations.find({
          where: {
            paymentId: payment.id,
            type: PaymentOperationType.REFUND,
          },
          lock: { mode: 'pessimistic_write' },
        }),
        payment.refundedAmount,
        amount,
        payment.capturedAmount,
      );
    } else if (type === PaymentOperationType.VOID) {
      if (
        payment.status !== PaymentStatus.AUTHORIZED ||
        toMinorUnits(payment.capturedAmount) !== 0n ||
        !authorization.providerReference ||
        authorization.providerReference !==
          this.requiredString(command.payload, 'authorizationId')
      ) {
        throw new ConflictException(
          'Only an uncaptured authorization can be voided',
        );
      }
      const priorVoid = await operations.findOne({
        where: [
          {
            paymentId: payment.id,
            type: PaymentOperationType.VOID,
            status: PaymentOperationStatus.PROCESSING,
          },
          {
            paymentId: payment.id,
            type: PaymentOperationType.VOID,
            status: PaymentOperationStatus.UNKNOWN,
          },
          {
            paymentId: payment.id,
            type: PaymentOperationType.VOID,
            status: PaymentOperationStatus.SUCCEEDED,
          },
        ],
        lock: { mode: 'pessimistic_write' },
      });
      if (priorVoid) {
        throw new ConflictException(
          'A void operation already exists for this authorization',
        );
      }
      const capture = await operations.findOne({
        where: [
          {
            paymentId: payment.id,
            type: PaymentOperationType.CAPTURE,
            status: PaymentOperationStatus.PROCESSING,
          },
          {
            paymentId: payment.id,
            type: PaymentOperationType.CAPTURE,
            status: PaymentOperationStatus.SUCCEEDED,
          },
          {
            paymentId: payment.id,
            type: PaymentOperationType.CAPTURE,
            status: PaymentOperationStatus.UNKNOWN,
          },
        ],
        lock: { mode: 'pessimistic_write' },
      });
      if (capture) {
        throw new ConflictException(
          'Payment cannot be voided while a capture exists or is pending',
        );
      }
    }
  }

  private assertNoConflictingOperations(
    operations: PaymentOperationEntity[],
    completedAmount: string,
    requestedAmount: string,
    limit: string,
  ): void {
    const reserved = operations
      .filter(
        (operation) =>
          operation.status === PaymentOperationStatus.PROCESSING ||
          operation.status === PaymentOperationStatus.UNKNOWN ||
          operation.status === PaymentOperationStatus.REQUIRES_RECONCILIATION,
      )
      .reduce(
        (sum, operation) =>
          sum + (operation.amount ? toMinorUnits(operation.amount) : 0n),
        0n,
      );
    if (
      toMinorUnits(completedAmount) + reserved + toMinorUnits(requestedAmount) >
      toMinorUnits(limit)
    ) {
      throw new ConflictException(
        'Payment operation exceeds the remaining authorized or captured amount',
      );
    }
  }

  private createProviderRequest(
    command: PaymentCommandRecord,
    operation: PaymentOperationEntity,
    payment: PaymentEntity,
    authorizationReference: string | null,
    providerTransactionReference: string | null = null,
  ): PaymentProviderRequest {
    const amount =
      operation.type === PaymentOperationType.AUTHORIZE
        ? payment.amount
        : operation.type === PaymentOperationType.VOID
          ? payment.authorizedAmount
          : operation.amount!;
    const request: PaymentProviderRequest = {
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
      orderId: payment.orderId,
      amount,
      currency: payment.currency,
      timeoutMs: 15_000,
    };
    if (operation.providerReference) {
      request.providerReference = operation.providerReference;
    }
    if (operation.type === PaymentOperationType.AUTHORIZE) {
      const methodReference = command.payload.paymentMethodReference;
      if (methodReference !== undefined) {
        if (
          typeof methodReference !== 'string' ||
          methodReference.trim().length === 0 ||
          methodReference.length > 255
        ) {
          throw new PaymentCommandValidationError(
            'Payment method reference is invalid',
          );
        }
        request.paymentMethodReference = methodReference;
      }
    }
    if (operation.type !== PaymentOperationType.AUTHORIZE) {
      if (operation.type === PaymentOperationType.VOID) {
        const commandAuthorization = this.requiredString(
          command.payload,
          'authorizationId',
        );
        if (
          authorizationReference &&
          authorizationReference !== commandAuthorization
        ) {
          throw new ConflictException(
            'Void authorization reference does not match the persisted authorization',
          );
        }
        request.authorizationReference =
          authorizationReference ?? commandAuthorization;
      } else {
        request.authorizationReference = authorizationReference ?? undefined;
      }
    }
    if (operation.type === PaymentOperationType.REFUND) {
      request.providerTransactionReference =
        providerTransactionReference ?? undefined;
    }
    return request;
  }

  private async getCapturedProviderReference(
    manager: EntityManager,
    payment: PaymentEntity,
    type: PaymentOperationType,
  ): Promise<string | null> {
    if (type !== PaymentOperationType.REFUND) {
      return null;
    }
    const transaction = await manager
      .getRepository(PaymentTransactionEntity)
      .findOne({
        where: {
          paymentId: payment.id,
          transactionType: PaymentOperationType.CAPTURE,
          status: 'SUCCEEDED',
        },
        order: { createdAt: 'DESC' },
      });
    return transaction?.providerReference ?? null;
  }

  private invokeProvider(
    type: PaymentOperationType,
    request: PaymentProviderRequest,
  ): Promise<PaymentProviderResult> {
    switch (type) {
      case PaymentOperationType.AUTHORIZE:
        return this.provider.authorize(request);
      case PaymentOperationType.CAPTURE:
        return this.provider.capture(request);
      case PaymentOperationType.VOID:
        return this.provider.void(request);
      case PaymentOperationType.REFUND:
        return this.provider.refund(request);
      case PaymentOperationType.RECONCILE:
        throw new ConflictException('Reconciliation is not a payment command');
    }
  }

  private async persistProviderResult(
    command: PaymentCommandRecord,
    prepared: PreparedOperation,
    result: PaymentProviderResult,
  ): Promise<void> {
    if (result.status === 'PROCESSING' || result.status === 'UNKNOWN') {
      await this.persistUncertainOutcome(
        command,
        prepared,
        result.failureCode ?? 'PROVIDER_OUTCOME_UNKNOWN',
        result,
      );
      return;
    }

    await this.withTransaction(async (manager) => {
      const operations = manager.getRepository(PaymentOperationEntity);
      const payments = manager.getRepository(PaymentEntity);
      const operation = await operations.findOneOrFail({
        where: { operationId: prepared.operation.operationId },
        lock: { mode: 'pessimistic_write' },
      });
      const payment = await payments.findOneOrFail({
        where: { id: prepared.payment.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        operation.status === PaymentOperationStatus.SUCCEEDED ||
        operation.status === PaymentOperationStatus.FAILED ||
        operation.status === PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED
      ) {
        return;
      }

      const succeeded = result.status === 'SUCCEEDED';
      assertOperationTransition(
        operation.status,
        succeeded
          ? PaymentOperationStatus.SUCCEEDED
          : PaymentOperationStatus.FAILED,
      );
      operation.status = succeeded
        ? PaymentOperationStatus.SUCCEEDED
        : PaymentOperationStatus.FAILED;
      const providerReference =
        operation.type === PaymentOperationType.AUTHORIZE
          ? (result.authorizationReference ?? result.providerReference)
          : result.providerReference;
      const duplicateOperationReference = providerReference
        ? await operations.findOne({
            where: { providerReference },
          })
        : null;
      operation.providerReference = duplicateOperationReference
        ? null
        : providerReference;
      operation.failureCode = succeeded ? null : 'PAYMENT_DECLINED';
      operation.failureReason = succeeded
        ? null
        : this.failureReason(operation.type);
      operation.processingLeaseUntil = null;
      operation.nextReconciliationAt = null;
      operation.manualInterventionAt = null;
      await operations.save(operation);

      if (succeeded) {
        this.applySuccessfulOperation(payment, operation);
      } else if (operation.type === PaymentOperationType.AUTHORIZE) {
        assertPaymentTransition(payment.status, PaymentStatus.FAILED);
        payment.status = PaymentStatus.FAILED;
      }
      await payments.save(payment);
      const transactionReference = result.providerReference
        ? await manager
            .getRepository(PaymentTransactionEntity)
            .findOne({ where: { providerReference: result.providerReference } })
        : null;
      await manager.getRepository(PaymentTransactionEntity).save({
        id: randomUUID(),
        paymentId: payment.id,
        operationId: operation.operationId,
        providerReference: transactionReference
          ? null
          : result.providerReference,
        transactionType: operation.type,
        status: succeeded ? 'SUCCEEDED' : 'FAILED',
        amount: operation.amount ?? payment.amount,
        currency: payment.currency,
      });
      await this.createResultEvent(
        manager,
        command,
        payment,
        operation,
        result,
      );

      await this.markInboxProcessed(manager, command.commandId);
      if (operation.commandId !== command.commandId) {
        await this.markInboxProcessed(manager, operation.commandId);
      }
    });
  }

  private applySuccessfulOperation(
    payment: PaymentEntity,
    operation: PaymentOperationEntity,
  ): void {
    switch (operation.type) {
      case PaymentOperationType.AUTHORIZE:
        assertPaymentTransition(payment.status, PaymentStatus.AUTHORIZED);
        payment.authorizedAmount = operation.amount!;
        payment.status = PaymentStatus.AUTHORIZED;
        break;
      case PaymentOperationType.CAPTURE: {
        const captured =
          toMinorUnits(payment.capturedAmount) +
          toMinorUnits(operation.amount!);
        payment.capturedAmount = this.fromMinorUnits(captured);
        const next =
          captured === toMinorUnits(payment.authorizedAmount)
            ? PaymentStatus.CAPTURED
            : PaymentStatus.PARTIALLY_CAPTURED;
        assertPaymentTransition(payment.status, next);
        payment.status = next;
        break;
      }
      case PaymentOperationType.VOID:
        assertPaymentTransition(payment.status, PaymentStatus.VOIDED);
        payment.status = PaymentStatus.VOIDED;
        break;
      case PaymentOperationType.REFUND: {
        const refunded =
          toMinorUnits(payment.refundedAmount) +
          toMinorUnits(operation.amount!);
        payment.refundedAmount = this.fromMinorUnits(refunded);
        const next =
          refunded === toMinorUnits(payment.capturedAmount)
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED;
        assertPaymentTransition(payment.status, next);
        payment.status = next;
        break;
      }
      case PaymentOperationType.RECONCILE:
        throw new ConflictException('Unexpected reconciliation result');
    }
  }

  private async persistUncertainOutcome(
    command: PaymentCommandRecord,
    prepared: PreparedOperation,
    code: string,
    result?: PaymentProviderResult,
  ): Promise<void> {
    await this.withTransaction(async (manager) => {
      const operations = manager.getRepository(PaymentOperationEntity);
      const payments = manager.getRepository(PaymentEntity);
      const operation = await operations.findOneOrFail({
        where: { operationId: prepared.operation.operationId },
        lock: { mode: 'pessimistic_write' },
      });
      const payment = await payments.findOneOrFail({
        where: { id: prepared.payment.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        operation.status === PaymentOperationStatus.SUCCEEDED ||
        operation.status === PaymentOperationStatus.FAILED ||
        operation.status === PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED
      ) {
        return;
      }
      assertOperationTransition(
        operation.status,
        PaymentOperationStatus.UNKNOWN,
      );
      operation.status = PaymentOperationStatus.UNKNOWN;
      operation.failureCode = code;
      operation.failureReason = 'Provider outcome requires reconciliation';
      operation.processingLeaseUntil = null;
      operation.nextReconciliationAt = new Date(
        Date.now() + RECONCILIATION_RETRY_BASE_MS,
      );
      if (result) {
        const providerReference =
          operation.type === PaymentOperationType.AUTHORIZE
            ? (result.authorizationReference ?? result.providerReference)
            : result.providerReference;
        if (providerReference) {
          const existingReference = await operations.findOne({
            where: { providerReference },
          });
          operation.providerReference = existingReference
            ? operation.providerReference
            : providerReference;
        }
      }
      await operations.save(operation);
      if (payment.status !== PaymentStatus.REQUIRES_RECONCILIATION) {
        assertPaymentTransition(
          payment.status,
          PaymentStatus.REQUIRES_RECONCILIATION,
        );
        payment.status = PaymentStatus.REQUIRES_RECONCILIATION;
        await payments.save(payment);
      }
      this.logger.error(
        JSON.stringify({
          event: 'payment.operation.outcome_uncertain',
          orderId: command.aggregateId,
          operationId: operation.operationId,
          operationType: operation.type,
          correlationId: command.correlationId,
          causationId: command.causationId,
        }),
      );
      this.logger.warn(
        JSON.stringify({
          event: 'payment.metric',
          metric: 'payment_unknown_operations_total',
          value: 1,
          operationType: operation.type,
          correlationId: command.correlationId,
        }),
      );
    });
  }

  private async prepareReconciliation(
    operationId: string,
  ): Promise<PreparedReconciliation> {
    return this.withTransaction(async (manager) => {
      const operations = manager.getRepository(PaymentOperationEntity);
      const operation = await operations.findOneOrFail({
        where: { id: operationId },
      });
      const payment = await manager
        .getRepository(PaymentEntity)
        .findOneOrFail({ where: { id: operation.paymentId } });
      const inbox = await manager
        .getRepository(InboxEventEntity)
        .findOneOrFail({ where: { eventId: operation.commandId } });
      const authorization = operation.authorizationOperationId
        ? await operations.findOne({
            where: {
              operationId: operation.authorizationOperationId,
              paymentId: payment.id,
              type: PaymentOperationType.AUTHORIZE,
            },
          })
        : operation.type === PaymentOperationType.AUTHORIZE
          ? operation
          : null;
      const commandType = this.commandType(operation.type);
      const command: PaymentCommandRecord = {
        commandId: operation.commandId,
        commandType,
        eventVersion: 1,
        aggregateId: payment.orderId,
        occurredAt: operation.createdAt.toISOString(),
        correlationId: inbox.correlationId,
        causationId: operation.commandId,
        payload: {
          orderId: payment.orderId,
          paymentOperationId:
            operation.authorizationOperationId ?? operation.operationId,
          authorizationId: authorization?.providerReference ?? '',
        },
      };
      const providerRequest = this.createProviderRequest(
        command,
        operation,
        payment,
        authorization?.providerReference ?? null,
        await this.getCapturedProviderReference(
          manager,
          payment,
          operation.type,
        ),
      );
      return {
        duplicate: false,
        recoverExistingOperation: true,
        payment,
        operation,
        providerRequest,
        command,
      };
    });
  }

  private async recordReconciliationAttempt(
    operationId: string,
    maxAttempts: number,
    failureCode: string,
  ): Promise<void> {
    const escalatedType = await this.withTransaction(async (manager) => {
      const operations = manager.getRepository(PaymentOperationEntity);
      const operation = await operations.findOneOrFail({
        where: { id: operationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        operation.status === PaymentOperationStatus.SUCCEEDED ||
        operation.status === PaymentOperationStatus.FAILED ||
        operation.status === PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED
      ) {
        return null;
      }

      operation.reconciliationAttemptCount =
        (operation.reconciliationAttemptCount ?? 0) + 1;
      if (operation.status === PaymentOperationStatus.PROCESSING) {
        assertOperationTransition(
          operation.status,
          PaymentOperationStatus.UNKNOWN,
        );
        operation.status = PaymentOperationStatus.UNKNOWN;
        const payment = await manager
          .getRepository(PaymentEntity)
          .findOneOrFail({
            where: { id: operation.paymentId },
            lock: { mode: 'pessimistic_write' },
          });
        if (payment.status !== PaymentStatus.REQUIRES_RECONCILIATION) {
          assertPaymentTransition(
            payment.status,
            PaymentStatus.REQUIRES_RECONCILIATION,
          );
          payment.status = PaymentStatus.REQUIRES_RECONCILIATION;
          await manager.getRepository(PaymentEntity).save(payment);
        }
      }
      operation.failureCode = failureCode;
      operation.failureReason = 'Provider outcome remains unresolved';
      operation.processingLeaseUntil = null;
      if (operation.reconciliationAttemptCount >= maxAttempts) {
        assertOperationTransition(
          operation.status,
          PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED,
        );
        operation.status = PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED;
        operation.manualInterventionAt = new Date();
        operation.nextReconciliationAt = null;
        await this.markInboxProcessed(manager, operation.commandId);
      } else {
        const delay = Math.min(
          RECONCILIATION_RETRY_MAX_MS,
          RECONCILIATION_RETRY_BASE_MS *
            2 ** Math.min(operation.reconciliationAttemptCount - 1, 10),
        );
        operation.nextReconciliationAt = new Date(Date.now() + delay);
      }
      await operations.save(operation);
      return operation.status ===
        PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED
        ? operation.type
        : null;
    });

    if (escalatedType) {
      this.logger.error(
        JSON.stringify({
          event: 'payment.reconciliation.manual_intervention_required',
          operationId,
          failureCode,
          alert: true,
        }),
      );
      if (
        escalatedType === PaymentOperationType.VOID ||
        escalatedType === PaymentOperationType.REFUND
      ) {
        this.logger.error(
          JSON.stringify({
            event: 'payment.compensation.manual_intervention_required',
            operationId,
            failureCode,
            alert: true,
          }),
        );
      }
    } else {
      this.logger.warn(
        JSON.stringify({
          event: 'payment.reconciliation.retry_scheduled',
          operationId,
          failureCode,
        }),
      );
    }
  }

  private async persistManualIntervention(
    command: PaymentCommandRecord,
    prepared: PreparedOperation,
    failureCode: string,
  ): Promise<void> {
    await this.withTransaction(async (manager) => {
      const operations = manager.getRepository(PaymentOperationEntity);
      const operation = await operations.findOneOrFail({
        where: { operationId: prepared.operation.operationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        operation.status === PaymentOperationStatus.SUCCEEDED ||
        operation.status === PaymentOperationStatus.FAILED ||
        operation.status === PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED
      ) {
        return;
      }
      assertOperationTransition(
        operation.status,
        PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED,
      );
      operation.status = PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED;
      operation.failureCode = failureCode;
      operation.failureReason =
        'Provider authentication requires operational intervention';
      operation.processingLeaseUntil = null;
      operation.nextReconciliationAt = null;
      operation.manualInterventionAt = new Date();
      await operations.save(operation);

      const payment = await manager
        .getRepository(PaymentEntity)
        .findOneOrFail({
          where: { id: prepared.payment.id },
          lock: { mode: 'pessimistic_write' },
        });
      if (payment.status !== PaymentStatus.REQUIRES_RECONCILIATION) {
        assertPaymentTransition(
          payment.status,
          PaymentStatus.REQUIRES_RECONCILIATION,
        );
        payment.status = PaymentStatus.REQUIRES_RECONCILIATION;
        await manager.getRepository(PaymentEntity).save(payment);
      }
      await this.markInboxProcessed(manager, command.commandId);
    });
    this.logger.error(
      JSON.stringify({
        event: 'payment.operation.manual_intervention_required',
        commandId: command.commandId,
        operationId: prepared.operation.operationId,
        failureCode,
        alert: true,
      }),
    );
  }

  private async escalateOperation(
    operationId: string,
    failureCode: string,
  ): Promise<void> {
    const operationType = await this.withTransaction(async (manager) => {
      const operations = manager.getRepository(PaymentOperationEntity);
      const operation = await operations.findOneOrFail({
        where: { id: operationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        operation.status === PaymentOperationStatus.SUCCEEDED ||
        operation.status === PaymentOperationStatus.FAILED ||
        operation.status === PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED
      ) {
        return null;
      }
      assertOperationTransition(
        operation.status,
        PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED,
      );
      operation.status = PaymentOperationStatus.MANUAL_INTERVENTION_REQUIRED;
      operation.failureCode = failureCode;
      operation.failureReason =
        'Provider authentication requires operational intervention';
      operation.processingLeaseUntil = null;
      operation.nextReconciliationAt = null;
      operation.manualInterventionAt = new Date();
      await operations.save(operation);

      const payment = await manager.getRepository(PaymentEntity).findOneOrFail({
        where: { id: operation.paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (payment.status !== PaymentStatus.REQUIRES_RECONCILIATION) {
        assertPaymentTransition(
          payment.status,
          PaymentStatus.REQUIRES_RECONCILIATION,
        );
        payment.status = PaymentStatus.REQUIRES_RECONCILIATION;
        await manager.getRepository(PaymentEntity).save(payment);
      }
      await this.markInboxProcessed(manager, operation.commandId);
      return operation.type;
    });
    if (!operationType) return;
    this.logger.error(
      JSON.stringify({
        event: 'payment.reconciliation.manual_intervention_required',
        operationId,
        failureCode,
        alert: true,
      }),
    );
    if (
      operationType === PaymentOperationType.VOID ||
      operationType === PaymentOperationType.REFUND
    ) {
      this.logger.error(
        JSON.stringify({
          event: 'payment.compensation.manual_intervention_required',
          operationId,
          failureCode,
          alert: true,
        }),
      );
    }
  }

  private async markInboxProcessed(
    manager: EntityManager,
    commandId: string,
  ): Promise<void> {
    const inbox = await manager.getRepository(InboxEventEntity).findOneOrFail({
      where: { eventId: commandId },
      lock: { mode: 'pessimistic_write' },
    });
    inbox.status = InboxEventStatus.PROCESSED;
    inbox.processedAt = new Date();
    await manager.getRepository(InboxEventEntity).save(inbox);
  }

  private async withTransaction<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.dataSource.transaction(work);
      } catch (error) {
        if (!(error instanceof QueryFailedError)) throw error;
        const code = error.driverError.code;
        if (
          !['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', '40001'].includes(
            code,
          ) ||
          attempt >= 3
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
        this.logger.warn(
          JSON.stringify({
            event: 'payment.database.transaction_retry',
            retry: attempt + 1,
            reason: code,
          }),
        );
      }
    }
  }

  private logProviderMetric(
    type: PaymentOperationType,
    outcome: string,
    latencyMs: number,
    correlationId: string,
    context: Record<string, unknown>,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'payment.metric',
        metric: `payment_provider_${type.toLowerCase()}_latency_ms`,
        value: latencyMs,
        outcome,
        correlationId,
        ...context,
      }),
    );
    this.logger.log(
      JSON.stringify({
        event: 'payment.metric',
        metric: `payment_${type.toLowerCase()}_operations_total`,
        value: 1,
        outcome,
        correlationId,
        ...context,
      }),
    );
  }

  private operationLogContext(
    command: PaymentCommandRecord,
    operation: PaymentOperationEntity,
  ): Record<string, unknown> {
    return {
      orderId: command.aggregateId,
      sagaId: command.payload.sagaId ?? null,
      compensationStepId:
        operation.type === PaymentOperationType.VOID ||
        operation.type === PaymentOperationType.REFUND
          ? operation.operationId
          : null,
      commandId: command.commandId,
      correlationId: command.correlationId,
    };
  }

  private commandType(type: PaymentOperationType): SupportedCommandType {
    switch (type) {
      case PaymentOperationType.AUTHORIZE:
        return PAYMENT_AUTHORIZE_COMMAND_TYPE;
      case PaymentOperationType.CAPTURE:
        return PAYMENT_CAPTURE_COMMAND_TYPE;
      case PaymentOperationType.VOID:
        return PAYMENT_VOID_COMMAND_TYPE;
      case PaymentOperationType.REFUND:
        return PAYMENT_REFUND_COMMAND_TYPE;
      case PaymentOperationType.RECONCILE:
        throw new ConflictException('Reconciliation is not a payment command');
    }
  }

  private async createResultEvent(
    manager: EntityManager,
    command: PaymentCommandRecord,
    payment: PaymentEntity,
    operation: PaymentOperationEntity,
    result: PaymentProviderResult,
  ): Promise<void> {
    const succeeded = result.status === 'SUCCEEDED';
    const eventType = this.resultEventType(operation.type, succeeded);
    const payload = this.resultPayload(
      command,
      operation,
      payment,
      result,
      succeeded,
    );
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();
    await manager.getRepository(OutboxEventEntity).save({
      id: eventId,
      eventId,
      aggregateType: 'Payment',
      aggregateId: payment.orderId,
      eventType,
      payload: {
        eventId,
        eventType,
        eventVersion: 1,
        aggregateId: payment.orderId,
        occurredAt,
        correlationId: command.correlationId,
        causationId: command.commandId,
        payload,
      },
      status: 'PENDING',
      publishedAt: null,
      failedAt: null,
      retryCount: 0,
      nextRetryAt: new Date(),
      lastError: null,
      lockedUntil: null,
    });
  }

  private resultPayload(
    command: PaymentCommandRecord,
    operation: PaymentOperationEntity,
    payment: PaymentEntity,
    result: PaymentProviderResult,
    succeeded: boolean,
  ): Record<string, string | null> {
    const common = {
      paymentId: payment.id,
      orderId: payment.orderId,
      ...(operation.type === PaymentOperationType.VOID ||
      operation.type === PaymentOperationType.REFUND
        ? { sagaId: this.requiredString(command.payload, 'sagaId') }
        : {}),
      paymentOperationId:
        operation.authorizationOperationId ?? operation.operationId,
    };
    if (!succeeded) {
      return {
        ...common,
        ...(operation.type === PaymentOperationType.CAPTURE
          ? { captureOperationId: operation.operationId }
          : {}),
        ...(operation.type === PaymentOperationType.REFUND
          ? { refundOperationId: operation.operationId }
          : {}),
        ...(operation.type === PaymentOperationType.VOID
          ? { voidOperationId: operation.operationId }
          : {}),
        amount: operation.amount ?? payment.amount,
        currency: payment.currency,
        reasonCode: 'PAYMENT_DECLINED',
        reason: this.failureReason(operation.type),
      };
    }

    if (operation.type === PaymentOperationType.AUTHORIZE) {
      return {
        ...common,
        authorizationId:
          result.authorizationReference ??
          operation.providerReference ??
          operation.operationId,
        amount: operation.amount!,
        currency: payment.currency,
        providerReference: result.providerReference,
      };
    }
    if (operation.type === PaymentOperationType.CAPTURE) {
      return {
        ...common,
        captureOperationId: operation.operationId,
        captureId: result.providerReference ?? operation.operationId,
        amount: operation.amount!,
        currency: payment.currency,
      };
    }
    if (operation.type === PaymentOperationType.REFUND) {
      return {
        ...common,
        refundOperationId: operation.operationId,
        refundId: result.providerReference ?? operation.operationId,
        amount: operation.amount!,
        currency: payment.currency,
        providerReference: result.providerReference,
      };
    }
    return {
      ...common,
      voidOperationId: operation.operationId,
      authorizationId: this.requiredString(command.payload, 'authorizationId'),
      providerReference: result.providerReference,
    };
  }

  private resultEventType(
    type: PaymentOperationType,
    succeeded: boolean,
  ): string {
    switch (type) {
      case PaymentOperationType.AUTHORIZE:
        return succeeded
          ? PAYMENT_AUTHORIZED_EVENT_TYPE
          : PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE;
      case PaymentOperationType.CAPTURE:
        return succeeded
          ? PAYMENT_CAPTURED_EVENT_TYPE
          : PAYMENT_CAPTURE_FAILED_EVENT_TYPE;
      case PaymentOperationType.VOID:
        return succeeded
          ? PAYMENT_VOIDED_EVENT_TYPE
          : PAYMENT_VOID_FAILED_EVENT_TYPE;
      case PaymentOperationType.REFUND:
        return succeeded
          ? PAYMENT_REFUNDED_EVENT_TYPE
          : PAYMENT_REFUND_FAILED_EVENT_TYPE;
      case PaymentOperationType.RECONCILE:
        throw new ConflictException('Reconciliation has no result event here');
    }
  }

  private validateCommand(value: unknown): PaymentCommandRecord {
    if (!this.isRecord(value) || !this.isRecord(value.payload)) {
      throw new PaymentCommandValidationError();
    }
    const commandType = value.commandType;
    if (
      typeof commandType !== 'string' ||
      !(commandType in operationCommands) ||
      value.eventVersion !== 1 ||
      typeof value.commandId !== 'string' ||
      value.commandId.trim().length === 0 ||
      value.commandId.length > 36 ||
      typeof value.aggregateId !== 'string' ||
      value.aggregateId.trim().length === 0 ||
      value.aggregateId.length > 36 ||
      typeof value.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(value.occurredAt)) ||
      typeof value.correlationId !== 'string' ||
      value.correlationId.trim().length === 0 ||
      value.correlationId.length > 36 ||
      (value.causationId !== null &&
        (typeof value.causationId !== 'string' ||
          value.causationId.length > 36)) ||
      value.commandType !== commandType
    ) {
      throw new PaymentCommandValidationError();
    }
    const payload = value.payload;
    if (
      typeof payload.orderId !== 'string' ||
      payload.orderId.trim().length === 0 ||
      payload.orderId.length > 36 ||
      payload.orderId !== value.aggregateId
    ) {
      throw new PaymentCommandValidationError();
    }
    const command = value as unknown as PaymentCommandRecord;
    this.operationId(command);
    if (commandType === PAYMENT_AUTHORIZE_COMMAND_TYPE) {
      this.requiredString(payload, 'customerId');
      this.validateAmountAndCurrency(
        this.requiredString(payload, 'amount'),
        this.requiredString(payload, 'currency'),
      );
    } else if (commandType === PAYMENT_CAPTURE_COMMAND_TYPE) {
      this.requiredIdentifier(payload, 'paymentOperationId');
      this.validateAmountAndCurrency(
        this.requiredString(payload, 'amount'),
        this.requiredString(payload, 'currency'),
      );
    } else if (commandType === PAYMENT_REFUND_COMMAND_TYPE) {
      this.requiredIdentifier(payload, 'sagaId');
      this.requiredIdentifier(payload, 'paymentOperationId');
      this.requiredIdentifier(payload, 'refundOperationId');
      this.requiredString(payload, 'reasonCode');
      this.validateAmountAndCurrency(
        this.requiredString(payload, 'amount'),
        this.requiredString(payload, 'currency'),
      );
    } else {
      this.requiredIdentifier(payload, 'sagaId');
      this.requiredIdentifier(payload, 'paymentOperationId');
      this.requiredIdentifier(payload, 'voidOperationId');
      this.requiredString(payload, 'authorizationId');
      this.requiredString(payload, 'reasonCode');
    }
    return command;
  }

  private operationId(command: PaymentCommandRecord): string {
    const field =
      command.commandType === PAYMENT_AUTHORIZE_COMMAND_TYPE
        ? 'paymentOperationId'
        : command.commandType === PAYMENT_CAPTURE_COMMAND_TYPE
          ? 'captureOperationId'
          : command.commandType === PAYMENT_VOID_COMMAND_TYPE
            ? 'voidOperationId'
            : 'refundOperationId';
    return this.requiredIdentifier(command.payload, field);
  }

  private requiredIdentifier(
    payload: Record<string, unknown>,
    field: string,
  ): string {
    const identifier = this.requiredString(payload, field);
    if (typeof identifier !== 'string' || identifier.length > 36) {
      throw new PaymentCommandValidationError(
        `Payment command field ${field} is invalid`,
      );
    }
    return identifier;
  }

  private requiredString(
    value: Record<string, unknown>,
    field: string,
    required = true,
  ): string | null {
    const result = value[field];
    if (result === undefined && !required) {
      return null;
    }
    if (
      typeof result !== 'string' ||
      result.trim().length === 0 ||
      result.length > 255
    ) {
      throw new PaymentCommandValidationError(
        `Payment command field ${field} is invalid`,
      );
    }
    return result;
  }

  private validateAmountAndCurrency(amount: string, currency: string): void {
    assertPositivePaymentAmount(amount);
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new PaymentCommandValidationError('Payment currency is invalid');
    }
  }

  private canonicalAmount(amount: string): string {
    return this.fromMinorUnits(assertPositivePaymentAmount(amount));
  }

  private failureReason(type: PaymentOperationType): string {
    switch (type) {
      case PaymentOperationType.AUTHORIZE:
        return 'Payment authorization was declined';
      case PaymentOperationType.CAPTURE:
        return 'Payment capture was declined';
      case PaymentOperationType.VOID:
        return 'Payment authorization could not be voided';
      case PaymentOperationType.REFUND:
        return 'Payment refund was declined';
      case PaymentOperationType.RECONCILE:
        return 'Payment reconciliation failed';
    }
  }

  private toStableFailureCode(error: unknown): string {
    const kind =
      typeof error === 'object' && error !== null && 'kind' in error
        ? error.kind
        : undefined;
    return kind === 'INVALID_RESPONSE'
      ? 'PROVIDER_INVALID_RESPONSE'
      : kind === 'RETRYABLE'
        ? 'PROVIDER_UNAVAILABLE'
        : 'PROVIDER_OUTCOME_UNKNOWN';
  }

  private fromMinorUnits(value: bigint): string {
    const whole = value / 10_000n;
    const fraction = (value % 10_000n).toString().padStart(4, '0');
    return `${whole}.${fraction}`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
