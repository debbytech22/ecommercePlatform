// import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
// import type { DataSourceOptions } from 'typeorm';

// /**
//  * Database configuration shared by the NestJS application and TypeORM CLI.
//  *
//  * Keeping the connection settings in one place reduces configuration drift
//  * between running the service and executing database migrations.
//  */
// export function getDatabaseOptions(
//   env: Record<string, string | undefined>,
// ): TypeOrmModuleOptions & DataSourceOptions {
//   // Fail fast if required database settings are missing.
//   const required = (
//     key: string,
//   ): string => {
//     const value = env[key];

//     if (!value) {
//       throw new Error(`Missing required environment variable: ${key}`);
//     }

//     return value;
//   };

//   // Validate the port instead of silently accepting an invalid value.
//   const port = Number(required('ORDER_DB_PORT'));

//   if (!Number.isInteger(port) || port < 1 || port > 65535) {
//     throw new Error('ORDER_DB_PORT must be an integer between 1 and 65535');
//   }

//   return {
//     type: 'mysql',
//     host: required('ORDER_DB_HOST'),
//     port,
//     username: required('ORDER_DB_USER'),
//     password: required('ORDER_DB_PASSWORD'),
//     database: required('ORDER_DB_NAME'),

//     // Entities are registered explicitly by the application and CLI.
//     entities: ['apps/order-service/src/**/*.entity{.ts,.js}'],

//     // Migration files are kept with the Order Service.
//     migrations: ['apps/order-service/src/database/migrations/*{.ts,.js}'],

//     // Schema changes must be applied through reviewed migrations.
//     synchronize: false,

//     // Do not run migrations automatically every time the service starts.
//     migrationsRun: false,

//     // Bound the connection pool for this service.
//     extra: {
//       connectionLimit: 10,
//     },
//   };
// }

import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';

import { OrderEntity } from '../entities/order.entity';
import { OrderItemEntity } from '../entities/order-item.entity';
import { OutboxEventEntity } from '../entities/outbox-event.entity';
import { InboxEventEntity } from '../inbox/inbox-event.entity';
import { OrderSagaEntity } from '../saga/entities/order-saga.entity';
import { SagaStepEntity } from '../saga/entities/saga-step.entity';
import { OrderStatusHistoryEntity } from '../entities/order-status-history.entity';

/**
 * Returns the MySQL options shared by NestJS and the TypeORM CLI.
 *
 * Paths are resolved relative to this file so the configuration can locate
 * entities and migrations in both the source tree and the compiled output.
 */
export function getDatabaseOptions(
  env: Record<string, string | undefined>,
): DataSourceOptions {
  /**
   * Require non-empty environment values without exposing their contents
   * in error messages.
   */
  const required = (key: string): string => {
    const value = env[key];

    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }

    return value;
  };

  // Convert and validate the port before passing it to the MySQL driver.
  const port = Number(required('ORDER_DB_PORT'));

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ORDER_DB_PORT must be an integer between 1 and 65535');
  }

  return {
    type: 'mysql',
    host: required('ORDER_DB_HOST'),
    port,
    username: required('ORDER_DB_USER'),
    password: required('ORDER_DB_PASSWORD'),
    database: required('ORDER_DB_NAME'),

    // Explicit classes work in both the bundled application and the CLI.
    entities: [
      InboxEventEntity,
      OrderEntity,
      OrderItemEntity,
      OrderStatusHistoryEntity,
      OrderSagaEntity,
      OutboxEventEntity,
      SagaStepEntity,
    ],
    migrations: [join(__dirname, '..', 'database', 'migrations', '*{.js,.ts}')],

    // Never alter database schemas automatically at application startup.
    synchronize: false,

    // Migrations will be executed explicitly by the deployment workflow.
    migrationsRun: false,

    // Limit the number of simultaneous connections from this service.
    extra: {
      connectionLimit: 10,
    },
  };
}
