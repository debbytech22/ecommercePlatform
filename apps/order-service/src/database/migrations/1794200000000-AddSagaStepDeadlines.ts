import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSagaStepDeadlines1794200000000 implements MigrationInterface {
  name = 'AddSagaStepDeadlines1794200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `saga_steps` ADD `deadline_at` datetime(6) NULL',
    );
    await queryRunner.query(
      'CREATE INDEX `idx_saga_steps_recovery_deadline` ON `saga_steps` (`status`, `deadline_at`)',
    );
    await queryRunner.query(
      "UPDATE `saga_steps` step INNER JOIN `order_sagas` saga ON saga.`id` = step.`saga_id` SET step.`status` = 'IN_PROGRESS', step.`command_id` = COALESCE(step.`command_id`, saga.`correlation_id`), step.`attempts` = GREATEST(step.`attempts`, 1), step.`started_at` = COALESCE(step.`started_at`, saga.`started_at`), step.`deadline_at` = DATE_ADD(COALESCE(step.`updated_at`, saga.`started_at`), INTERVAL 60 SECOND) WHERE saga.`state` = 'INVENTORY_RESERVATION_PENDING' AND step.`step_type` = 'INVENTORY_RESERVATION' AND step.`status` = 'PENDING' AND step.`command_id` IS NULL",
    );
    await queryRunner.query(
      "UPDATE `saga_steps` SET `deadline_at` = DATE_ADD(COALESCE(`started_at`, `updated_at`), INTERVAL 60 SECOND) WHERE `status` = 'IN_PROGRESS' AND `deadline_at` IS NULL",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `idx_saga_steps_recovery_deadline` ON `saga_steps`',
    );
    await queryRunner.query(
      'ALTER TABLE `saga_steps` DROP COLUMN `deadline_at`',
    );
  }
}
