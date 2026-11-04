import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSagaCompensationState1794500000000 implements MigrationInterface {
  name = 'AddSagaCompensationState1794500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `order_sagas` ADD `compensation_reason` varchar(60) NULL, ADD `compensation_status` varchar(40) NULL, ADD `compensation_started_at` datetime(6) NULL, ADD `compensation_completed_at` datetime(6) NULL, ADD `compensation_failure_reason` varchar(1000) NULL',
    );
    await queryRunner.query(
      'ALTER TABLE `saga_steps` ADD `operation_id` char(36) NULL, ADD `next_retry_at` datetime(6) NULL',
    );
    await queryRunner.query(
      "UPDATE `saga_steps` SET `operation_id` = `id` WHERE `step_type` IN ('PAYMENT_VOID', 'PAYMENT_REFUND', 'INVENTORY_RELEASE')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `saga_steps` DROP COLUMN `next_retry_at`, DROP COLUMN `operation_id`',
    );
    await queryRunner.query(
      'ALTER TABLE `order_sagas` DROP COLUMN `compensation_failure_reason`, DROP COLUMN `compensation_completed_at`, DROP COLUMN `compensation_started_at`, DROP COLUMN `compensation_status`, DROP COLUMN `compensation_reason`',
    );
  }
}
