import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExpandPreferenceSchema1795200000000 implements MigrationInterface {
  name = 'ExpandPreferenceSchema1795200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`notification_preferences\`
        ADD COLUMN \`category\`           varchar(20)   NOT NULL DEFAULT 'TRANSACTIONAL' AFTER \`channel\`,
        ADD COLUMN \`suppressed_at\`      datetime(6)   NULL AFTER \`is_enabled\`,
        ADD COLUMN \`suppression_reason\` varchar(255)  NULL AFTER \`suppressed_at\`
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`notification_preferences\`
        DROP COLUMN \`suppression_reason\`,
        DROP COLUMN \`suppressed_at\`,
        DROP COLUMN \`category\`
    `);
  }
}
