import 'dotenv/config';
import { DataSource } from 'typeorm';
import { getPaymentDatabaseOptions } from './database-options';

export const PaymentServiceDataSource = new DataSource(
  getPaymentDatabaseOptions(process.env),
);
