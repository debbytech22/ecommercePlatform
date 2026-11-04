import 'dotenv/config';

import { DataSource } from 'typeorm';

import { getInventoryDatabaseOptions } from '../config/database-options';

export const InventoryServiceDataSource = new DataSource(
  getInventoryDatabaseOptions(process.env),
);
