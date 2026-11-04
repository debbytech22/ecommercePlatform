import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSagaStepLastErrorCode1794700000000 implements MigrationInterface {
  name = 'AddSagaStepLastErrorCode1794700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `saga_steps` ADD `last_error_code` varchar(100) NULL',
    );
    // Back-fill: treat the existing last_error value as the code for rows
    // already in a terminal error state where the value is short enough to
    // be a code (≤100 chars) and contains no spaces (i.e. looks like a code).
    await queryRunner.query(
      "UPDATE `saga_steps` SET `last_error_code` = `last_error` WHERE `last_error` IS NOT NULL AND LENGTH(`last_error`) <= 100 AND `last_error` NOT LIKE '% %'",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `saga_steps` DROP COLUMN `last_error_code`',
    );
  }
}
