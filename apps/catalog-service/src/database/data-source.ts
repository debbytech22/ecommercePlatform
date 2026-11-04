import 'dotenv/config';

import { DataSource } from 'typeorm';

import { getCatalogDatabaseOptions } from '../config/database-options';

export const CatalogServiceDataSource = new DataSource(
  getCatalogDatabaseOptions(process.env),
);
