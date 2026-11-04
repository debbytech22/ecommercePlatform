import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { InboxEventEntity } from '../inbox/entities/inbox-event.entity';
import { NotificationAttemptEntity } from '../notifications/entities/notification-attempt.entity';
import { NotificationEntity } from '../notifications/entities/notification.entity';
import { NotificationPreferenceEntity } from '../notifications/entities/notification-preference.entity';
import { OutboxEventEntity } from '../outbox/entities/outbox-event.entity';

export function getNotificationDatabaseOptions(
  env: Record<string, string | undefined>,
): DataSourceOptions {
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing required environment variable: ${key}`);
    return value;
  };

  const port = Number(required('NOTIFICATION_DB_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('NOTIFICATION_DB_PORT must be an integer between 1 and 65535');
  }

  return {
    type: 'mysql',
    host: required('NOTIFICATION_DB_HOST'),
    port,
    username: required('NOTIFICATION_DB_USER'),
    password: required('NOTIFICATION_DB_PASSWORD'),
    database: required('NOTIFICATION_DB_NAME'),
    entities: [
      NotificationEntity,
      NotificationAttemptEntity,
      NotificationPreferenceEntity,
      InboxEventEntity,
      OutboxEventEntity,
    ],
    migrations: [join(__dirname, '..', 'database', 'migrations', '*{.js,.ts}')],
    synchronize: false,
    migrationsRun: false,
    extra: { connectionLimit: 10 },
  };
}
