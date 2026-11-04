import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOutboxCommandIdConstraint1794600000000 implements MigrationInterface {
  name = 'AddOutboxCommandIdConstraint1794600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `outbox_events` ADD `command_id` char(36) NULL',
    );
    await queryRunner.query(
      "UPDATE `outbox_events` SET `command_id` = JSON_UNQUOTE(JSON_EXTRACT(`payload`, '$.commandId')) WHERE JSON_EXTRACT(`payload`, '$.commandId') IS NOT NULL",
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX `uq_outbox_command_id` ON `outbox_events` (`command_id`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `uq_outbox_command_id` ON `outbox_events`',
    );
    await queryRunner.query(
      'ALTER TABLE `outbox_events` DROP COLUMN `command_id`',
    );
  }
}
