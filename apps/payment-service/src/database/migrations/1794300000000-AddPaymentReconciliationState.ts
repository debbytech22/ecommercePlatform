import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPaymentReconciliationState1794300000000 implements MigrationInterface {
  name = 'AddPaymentReconciliationState1794300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `payment_operations` ADD `reconciliation_attempt_count` int unsigned NOT NULL DEFAULT 0, ADD `next_reconciliation_at` datetime(6) NULL, ADD `manual_intervention_at` datetime(6) NULL',
    );
    await queryRunner.query(
      'CREATE INDEX `idx_payment_operations_reconciliation` ON `payment_operations` (`operation_status`, `next_reconciliation_at`, `processing_lease_until`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `idx_payment_operations_reconciliation` ON `payment_operations`',
    );
    await queryRunner.query(
      'ALTER TABLE `payment_operations` DROP COLUMN `manual_intervention_at`, DROP COLUMN `next_reconciliation_at`, DROP COLUMN `reconciliation_attempt_count`',
    );
  }
}
