import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';

import { ProductEntity } from '../product.entity';

export function getCatalogDatabaseOptions(
  env: Record<string, string | undefined>,
): DataSourceOptions {
  const required = (key: string): string => {
    const value = env[key];

    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }

    return value;
  };

  const port = Number(required('CATALOG_DB_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CATALOG_DB_PORT must be an integer between 1 and 65535');
  }

  return {
    type: 'mysql',
    host: required('CATALOG_DB_HOST'),
    port,
    username: required('CATALOG_DB_USER'),
    password: required('CATALOG_DB_PASSWORD'),
    database: required('CATALOG_DB_NAME'),
    entities: [ProductEntity],
    migrations: [join(__dirname, '..', 'database', 'migrations', '*{.js,.ts}')],
    synchronize: false,
    migrationsRun: false,
    extra: {
      connectionLimit: 10,
    },
  };
}
