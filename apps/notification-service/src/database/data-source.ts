import 'dotenv/config';
import { DataSource } from 'typeorm';
import { getNotificationDatabaseOptions } from './database-options';

export const NotificationServiceDataSource = new DataSource(
  getNotificationDatabaseOptions(process.env),
);
