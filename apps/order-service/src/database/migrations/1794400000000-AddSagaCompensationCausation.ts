import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSagaCompensationCausation1794400000000 implements MigrationInterface {
  name = 'AddSagaCompensationCausation1794400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `order_sagas` ADD `compensation_causation_id` char(36) NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `order_sagas` DROP COLUMN `compensation_causation_id`',
    );
  }
}
