import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExpandOrderSaga1794100000000 implements MigrationInterface {
  name = 'ExpandOrderSaga1794100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `order_sagas` ADD `payment_operation_id` char(36) NULL, ADD `payment_authorization_id` varchar(128) NULL, ADD `failure_code` varchar(100) NULL, ADD `failure_reason` varchar(1000) NULL, ADD `started_at` datetime(6) NULL, ADD `completed_at` datetime(6) NULL, ADD `version` int UNSIGNED NOT NULL DEFAULT 1',
    );
    await queryRunner.query(
      "UPDATE `order_sagas` SET `completed_at` = CASE WHEN `state` IN ('CANCELLED', 'FAILED', 'COMPLETED') THEN `updated_at` ELSE NULL END, `started_at` = `created_at`, `failure_code` = CASE WHEN `last_error` IS NULL THEN NULL ELSE 'LEGACY_FAILURE' END, `failure_reason` = `last_error`",
    );
    await queryRunner.query(
      'ALTER TABLE `order_sagas` MODIFY `started_at` datetime(6) NOT NULL',
    );
    await queryRunner.query(
      "UPDATE `order_sagas` SET `state` = CASE `state` WHEN 'RESERVING_INVENTORY' THEN 'INVENTORY_RESERVATION_PENDING' WHEN 'PROCESSING_PAYMENT' THEN 'MANUAL_INTERVENTION_REQUIRED' WHEN 'COMPENSATING' THEN 'MANUAL_INTERVENTION_REQUIRED' WHEN 'CANCELLED' THEN CASE WHEN `last_error` IS NULL THEN 'COMPENSATED' ELSE 'FAILED' END WHEN 'REQUIRES_RECONCILIATION' THEN 'MANUAL_INTERVENTION_REQUIRED' ELSE `state` END, `failure_code` = CASE WHEN `state` = 'MANUAL_INTERVENTION_REQUIRED' AND `failure_code` IS NULL THEN 'LEGACY_UPGRADE' ELSE `failure_code` END, `failure_reason` = CASE WHEN `state` = 'MANUAL_INTERVENTION_REQUIRED' AND `failure_reason` IS NULL THEN 'Legacy Saga requires manual reconciliation after upgrade' ELSE `failure_reason` END",
    );
    await queryRunner.query(
      'ALTER TABLE `order_sagas` DROP COLUMN `last_error`',
    );
    await queryRunner.query(
      'ALTER TABLE `saga_steps` ADD `command_id` char(36) NULL, ADD `started_at` datetime(6) NULL, ADD `completed_at` datetime(6) NULL',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX `uq_saga_steps_command_id` ON `saga_steps` (`command_id`)',
    );
    await queryRunner.query(
      "UPDATE `saga_steps` SET `step_type` = 'PAYMENT_AUTHORIZATION' WHERE `step_type` = 'PAYMENT'",
    );
    await queryRunner.query(
      "UPDATE `saga_steps` SET `started_at` = `created_at`, `completed_at` = CASE WHEN `status` IN ('SUCCEEDED', 'FAILED', 'COMPENSATED', 'REQUIRES_RECONCILIATION') THEN `updated_at` ELSE NULL END WHERE `status` <> 'PENDING'",
    );
    await queryRunner.query(
      "ALTER TABLE `order_inbox_events` ADD `processing_status` varchar(20) NOT NULL DEFAULT 'RECEIVED'",
    );
    await queryRunner.query(
      'CREATE INDEX `idx_order_inbox_status_received` ON `order_inbox_events` (`processing_status`, `received_at`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `idx_order_inbox_status_received` ON `order_inbox_events`',
    );
    await queryRunner.query(
      'ALTER TABLE `order_inbox_events` DROP COLUMN `processing_status`',
    );
    await queryRunner.query(
      "UPDATE `saga_steps` SET `step_type` = 'PAYMENT' WHERE `step_type` = 'PAYMENT_AUTHORIZATION'",
    );
    await queryRunner.query(
      'DROP INDEX `uq_saga_steps_command_id` ON `saga_steps`',
    );
    await queryRunner.query(
      'ALTER TABLE `saga_steps` DROP COLUMN `command_id`, DROP COLUMN `started_at`, DROP COLUMN `completed_at`',
    );
    await queryRunner.query(
      'ALTER TABLE `order_sagas` ADD `last_error` varchar(1000) NULL',
    );
    await queryRunner.query(
      'UPDATE `order_sagas` SET `last_error` = `failure_reason`',
    );
    await queryRunner.query(
      'ALTER TABLE `order_sagas` DROP COLUMN `payment_operation_id`, DROP COLUMN `payment_authorization_id`, DROP COLUMN `failure_code`, DROP COLUMN `failure_reason`, DROP COLUMN `started_at`, DROP COLUMN `completed_at`, DROP COLUMN `version`',
    );
    await queryRunner.query(
      "UPDATE `order_sagas` SET `state` = CASE `state` WHEN 'INVENTORY_RESERVATION_PENDING' THEN 'RESERVING_INVENTORY' WHEN 'PAYMENT_PENDING' THEN 'PROCESSING_PAYMENT' WHEN 'COMPENSATED' THEN 'CANCELLED' WHEN 'MANUAL_INTERVENTION_REQUIRED' THEN 'REQUIRES_RECONCILIATION' ELSE `state` END",
    );
  }
}
