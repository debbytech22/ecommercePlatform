import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';

import { ProductInventoryEntity } from '../inventory/entities/product-inventory.entity';
import { InboxEventEntity } from '../inbox/entities/inbox-event.entity';
import { InventoryReservationItemEntity } from '../reservations/entities/inventory-reservation-item.entity';
import { InventoryReservationEntity } from '../reservations/entities/inventory-reservation.entity';
import { OutboxEventEntity } from '../outbox/entities/outbox-event.entity';

export function getInventoryDatabaseOptions(
  env: Record<string, string | undefined>,
): DataSourceOptions {
  const required = (key: string): string => {
    const value = env[key];
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  };

  const port = Number(required('INVENTORY_DB_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('INVENTORY_DB_PORT must be an integer between 1 and 65535');
  }

  return {
    type: 'mysql',
    host: required('INVENTORY_DB_HOST'),
    port,
    username: required('INVENTORY_DB_USER'),
    password: required('INVENTORY_DB_PASSWORD'),
    database: required('INVENTORY_DB_NAME'),
    entities: [
      ProductInventoryEntity,
      InventoryReservationEntity,
      InventoryReservationItemEntity,
      InboxEventEntity,
      OutboxEventEntity,
    ],
    migrations: [join(__dirname, '..', 'database', 'migrations', '*{.js,.ts}')],
    synchronize: false,
    migrationsRun: false,
    extra: { connectionLimit: 10 },
  };
}
