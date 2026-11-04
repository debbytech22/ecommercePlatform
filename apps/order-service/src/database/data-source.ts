// Load environment variables from the root .env when commands run from
// the monorepo root. Production environments should supply them externally.
import 'dotenv/config';

import { DataSource } from 'typeorm';
import { getDatabaseOptions } from '../config/database-options';

/**
 * Data source used by TypeORM CLI commands to generate, inspect,
 * and execute migrations for the Order Service.
 *
 * It shares connection settings, entities, and migration paths with NestJS.
 */
export const OrderServiceDataSource = new DataSource(
  getDatabaseOptions(process.env),
);