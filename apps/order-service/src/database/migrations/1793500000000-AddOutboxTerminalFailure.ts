import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOutboxTerminalFailure1793500000000 implements MigrationInterface {
  name = 'AddOutboxTerminalFailure1793500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `outbox_events` ADD `failed_at` datetime(6) NULL',
    );
    await queryRunner.query(
      'DROP INDEX `idx_outbox_pending` ON `outbox_events`',
    );
    await queryRunner.query(
      'CREATE INDEX `idx_outbox_pending` ON `outbox_events` (`published_at`, `failed_at`, `next_attempt_at`, `locked_until`, `created_at`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `idx_outbox_pending` ON `outbox_events`',
    );
    await queryRunner.query(
      'CREATE INDEX `idx_outbox_pending` ON `outbox_events` (`published_at`, `next_attempt_at`, `locked_until`, `created_at`)',
    );
    await queryRunner.query(
      'ALTER TABLE `outbox_events` DROP COLUMN `failed_at`',
    );
  }
}
