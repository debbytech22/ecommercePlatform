import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderRequestHashAndOutbox1793294329084
  implements MigrationInterface
{
  name = 'AddOrderRequestHashAndOutbox1793294329084';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `orders` ADD `request_hash` char(64) NULL',
    );
    await queryRunner.query(
      'CREATE TABLE `outbox_events` (`id` char(36) NOT NULL, `aggregate_type` varchar(80) NOT NULL, `aggregate_id` char(36) NOT NULL, `event_type` varchar(120) NOT NULL, `payload` json NOT NULL, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `published_at` datetime(6) NULL, `attempts` int UNSIGNED NOT NULL DEFAULT 0, `next_attempt_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `last_error` varchar(1000) NULL, INDEX `idx_outbox_pending` (`published_at`, `next_attempt_at`, `created_at`), PRIMARY KEY (`id`)) ENGINE=InnoDB',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `outbox_events`');
    await queryRunner.query('ALTER TABLE `orders` DROP COLUMN `request_hash`');
  }
}
