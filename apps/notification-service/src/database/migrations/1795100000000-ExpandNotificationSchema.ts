import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExpandNotificationSchema1795100000000 implements MigrationInterface {
  name = 'ExpandNotificationSchema1795100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // notifications: add order_id, event_id, template_key; replace idempotency_key unique with (event_id, recipient_address, channel)
    await queryRunner.query(`
      ALTER TABLE \`notifications\`
        ADD COLUMN \`order_id\`     char(36)     NULL        AFTER \`recipient_id\`,
        ADD COLUMN \`event_id\`     char(36)     NOT NULL DEFAULT '' AFTER \`order_id\`,
        ADD COLUMN \`template_key\` varchar(120) NOT NULL DEFAULT '' AFTER \`recipient_address\`,
        ADD UNIQUE KEY \`uq_notification_event_recipient_channel\` (\`event_id\`, \`recipient_address\`, \`channel\`)
    `);

    // Back-fill event_id from idempotency_key (format: type:channel:eventId — last segment)
    await queryRunner.query(`
      UPDATE \`notifications\`
      SET \`event_id\` = SUBSTRING_INDEX(\`idempotency_key\`, ':', -1)
      WHERE \`event_id\` = ''
    `);

    // notification_attempts: add provider, error_code, completed_at
    await queryRunner.query(`
      ALTER TABLE \`notification_attempts\`
        ADD COLUMN \`provider\`      varchar(60)   NULL AFTER \`channel\`,
        ADD COLUMN \`error_code\`    varchar(100)  NULL AFTER \`error_message\`,
        ADD COLUMN \`completed_at\`  datetime(6)   NULL AFTER \`attempted_at\`
    `);

    // notification_inbox_events: add error_message
    await queryRunner.query(`
      ALTER TABLE \`notification_inbox_events\`
        ADD COLUMN \`error_message\` varchar(1000) NULL AFTER \`processed_at\`
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`notification_inbox_events\`
        DROP COLUMN \`error_message\`
    `);
    await queryRunner.query(`
      ALTER TABLE \`notification_attempts\`
        DROP COLUMN \`completed_at\`,
        DROP COLUMN \`error_code\`,
        DROP COLUMN \`provider\`
    `);
    await queryRunner.query(`
      ALTER TABLE \`notifications\`
        DROP KEY \`uq_notification_event_recipient_channel\`,
        DROP COLUMN \`template_key\`,
        DROP COLUMN \`event_id\`,
        DROP COLUMN \`order_id\`
    `);
  }
}
