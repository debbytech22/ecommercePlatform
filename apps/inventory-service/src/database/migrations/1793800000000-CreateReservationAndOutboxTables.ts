import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReservationAndOutboxTables1793800000000 implements MigrationInterface {
  name = 'CreateReservationAndOutboxTables1793800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "CREATE TABLE `inventory_reservations` (`id` char(36) NOT NULL, `order_id` char(36) NOT NULL, `status` varchar(32) NOT NULL, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_inventory_reservations_order_id` (`order_id`), PRIMARY KEY (`id`), CONSTRAINT `chk_inventory_reservation_status` CHECK (`status` IN ('RESERVED', 'FAILED'))) ENGINE=InnoDB",
    );
    await queryRunner.query(
      'CREATE TABLE `inventory_reservation_items` (`id` char(36) NOT NULL, `reservation_id` char(36) NOT NULL, `product_id` varchar(120) NOT NULL, `quantity` int UNSIGNED NOT NULL, UNIQUE INDEX `uq_inventory_reservation_items_reservation_product` (`reservation_id`, `product_id`), INDEX `idx_inventory_reservation_items_product` (`product_id`), PRIMARY KEY (`id`), CONSTRAINT `chk_inventory_reservation_item_quantity` CHECK (`quantity` > 0), CONSTRAINT `fk_inventory_reservation_items_reservation` FOREIGN KEY (`reservation_id`) REFERENCES `inventory_reservations` (`id`) ON DELETE CASCADE, CONSTRAINT `fk_inventory_reservation_items_product` FOREIGN KEY (`product_id`) REFERENCES `product_inventory` (`product_id`)) ENGINE=InnoDB',
    );
    await queryRunner.query(
      'CREATE TABLE `outbox_events` (`id` char(36) NOT NULL, `aggregate_type` varchar(80) NOT NULL, `aggregate_id` char(36) NOT NULL, `event_type` varchar(120) NOT NULL, `payload` json NOT NULL, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `published_at` datetime(6) NULL, `failed_at` datetime(6) NULL, `attempts` int UNSIGNED NOT NULL DEFAULT 0, `next_attempt_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `last_error` varchar(1000) NULL, `locked_by` char(36) NULL, `locked_until` datetime(6) NULL, INDEX `idx_inventory_outbox_pending` (`published_at`, `failed_at`, `next_attempt_at`, `locked_until`, `created_at`), PRIMARY KEY (`id`)) ENGINE=InnoDB',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `outbox_events`');
    await queryRunner.query('DROP TABLE `inventory_reservation_items`');
    await queryRunner.query('DROP TABLE `inventory_reservations`');
  }
}
