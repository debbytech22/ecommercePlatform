import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOutboxClaimLease1793403000000 implements MigrationInterface {
  name = 'AddOutboxClaimLease1793403000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `outbox_events` ADD `locked_by` char(36) NULL, ADD `locked_until` datetime(6) NULL',
    );
    await queryRunner.query(
      'DROP INDEX `idx_outbox_pending` ON `outbox_events`',
    );
    await queryRunner.query(
      'CREATE INDEX `idx_outbox_pending` ON `outbox_events` (`published_at`, `next_attempt_at`, `locked_until`, `created_at`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `idx_outbox_pending` ON `outbox_events`',
    );
    await queryRunner.query(
      'CREATE INDEX `idx_outbox_pending` ON `outbox_events` (`published_at`, `next_attempt_at`, `created_at`)',
    );
    await queryRunner.query(
      'ALTER TABLE `outbox_events` DROP COLUMN `locked_until`, DROP COLUMN `locked_by`',
    );
  }
}
