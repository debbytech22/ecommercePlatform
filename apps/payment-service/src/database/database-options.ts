import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { InboxEventEntity } from '../inbox/entities/inbox-event.entity';
import { OutboxEventEntity } from '../outbox/entities/outbox-event.entity';
import { PaymentEntity } from '../payments/entities/payment.entity';
import { PaymentOperationEntity } from '../payments/entities/payment-operation.entity';
import { PaymentTransactionEntity } from '../payments/entities/payment-transaction.entity';
import { ReconciliationHistoryEntity } from '../reconciliation/entities/reconciliation-history.entity';

export function getPaymentDatabaseOptions(
  env: Record<string, string | undefined>,
): DataSourceOptions {
  const required = (key: string): string => {
    const value = env[key];
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  };

  const port = Number(required('PAYMENT_DB_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PAYMENT_DB_PORT must be an integer between 1 and 65535');
  }

  return {
    type: 'mysql',
    host: required('PAYMENT_DB_HOST'),
    port,
    username: required('PAYMENT_DB_USER'),
    password: required('PAYMENT_DB_PASSWORD'),
    database: required('PAYMENT_DB_NAME'),
    entities: [
      PaymentEntity,
      PaymentOperationEntity,
      PaymentTransactionEntity,
      InboxEventEntity,
      OutboxEventEntity,
      ReconciliationHistoryEntity,
    ],
    migrations: [join(__dirname, 'migrations', '*{.js,.ts}')],
    synchronize: false,
    migrationsRun: false,
    extra: { connectionLimit: 10 },
  };
}
