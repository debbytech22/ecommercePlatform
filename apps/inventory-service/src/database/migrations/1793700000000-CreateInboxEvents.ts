import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInboxEvents1793700000000 implements MigrationInterface {
  name = 'CreateInboxEvents1793700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "CREATE TABLE `inbox_events` (`event_id` char(36) NOT NULL, `event_type` varchar(120) NOT NULL, `status` varchar(16) NOT NULL DEFAULT 'PROCESSING', `received_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `processed_at` datetime(6) NULL, INDEX `idx_inbox_event_status_received` (`status`, `received_at`), PRIMARY KEY (`event_id`), CONSTRAINT `chk_inbox_event_status` CHECK (`status` IN ('PROCESSING', 'PROCESSED'))) ENGINE=InnoDB",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `inbox_events`');
  }
}
