import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePaymentReconciliationHistory1794800000000
  implements MigrationInterface
{
  name = 'CreatePaymentReconciliationHistory1794800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`payment_reconciliation_history\` (
        \`id\`                 char(36)      NOT NULL,
        \`operation_id\`       char(36)      NOT NULL,
        \`attempt_number\`     int unsigned  NOT NULL,
        \`outcome\`            varchar(30)   NOT NULL,
        \`provider_status\`    varchar(30)   NULL,
        \`provider_reference\` varchar(255)  NULL,
        \`failure_code\`       varchar(100)  NULL,
        \`error_message\`      varchar(1000) NULL,
        \`attempted_at\`       datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        INDEX \`idx_recon_history_operation_id\` (\`operation_id\`, \`attempted_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE `payment_reconciliation_history`',
    );
  }
}
