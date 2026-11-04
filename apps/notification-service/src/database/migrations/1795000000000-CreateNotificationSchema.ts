import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNotificationSchema1795000000000 implements MigrationInterface {
  name = 'CreateNotificationSchema1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`notifications\` (
        \`id\`                   char(36)      NOT NULL,
        \`recipient_id\`         char(36)      NOT NULL,
        \`correlation_id\`       char(36)      NOT NULL,
        \`causation_id\`         char(36)      NULL,
        \`notification_type\`    varchar(60)   NOT NULL,
        \`channel\`              varchar(20)   NOT NULL,
        \`status\`               varchar(20)   NOT NULL,
        \`recipient_address\`    varchar(320)  NOT NULL,
        \`subject\`              varchar(255)  NOT NULL,
        \`body\`                 text          NOT NULL,
        \`retry_count\`          int unsigned  NOT NULL DEFAULT 0,
        \`next_retry_at\`        datetime(6)   NULL,
        \`sent_at\`              datetime(6)   NULL,
        \`last_error\`           varchar(1000) NULL,
        \`provider_message_id\`  varchar(255)  NULL,
        \`idempotency_key\`      varchar(120)  NOT NULL,
        \`created_at\`           datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`           datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_notification_idempotency_key\` (\`idempotency_key\`),
        INDEX \`idx_notification_recipient_status\` (\`recipient_id\`, \`status\`),
        INDEX \`idx_notification_correlation\` (\`correlation_id\`),
        INDEX \`idx_notification_pending\` (\`status\`, \`next_retry_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await queryRunner.query(`
      CREATE TABLE \`notification_attempts\` (
        \`id\`                   char(36)      NOT NULL,
        \`notification_id\`      char(36)      NOT NULL,
        \`attempt_number\`       int unsigned  NOT NULL,
        \`channel\`              varchar(20)   NOT NULL,
        \`status\`               varchar(20)   NOT NULL,
        \`provider_message_id\`  varchar(255)  NULL,
        \`error_message\`        varchar(1000) NULL,
        \`attempted_at\`         datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        INDEX \`idx_notification_attempt_notification_id\` (\`notification_id\`, \`attempted_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await queryRunner.query(`
      CREATE TABLE \`notification_preferences\` (
        \`id\`                   char(36)      NOT NULL,
        \`recipient_id\`         char(36)      NOT NULL,
        \`notification_type\`    varchar(60)   NOT NULL,
        \`channel\`              varchar(20)   NOT NULL,
        \`is_enabled\`           tinyint unsigned NOT NULL DEFAULT 1,
        \`created_at\`           datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`           datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_notification_preference\` (\`recipient_id\`, \`notification_type\`, \`channel\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await queryRunner.query(`
      CREATE TABLE \`notification_inbox_events\` (
        \`id\`                char(36)    NOT NULL,
        \`event_id\`          char(36)    NOT NULL,
        \`event_type\`        varchar(120) NOT NULL,
        \`aggregate_id\`      char(36)    NOT NULL,
        \`correlation_id\`    char(36)    NOT NULL,
        \`processing_status\` varchar(20) NOT NULL,
        \`received_at\`       datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`processed_at\`      datetime(6) NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_notification_inbox_event_id\` (\`event_id\`),
        INDEX \`idx_notification_inbox_status\` (\`processing_status\`, \`received_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await queryRunner.query(`
      CREATE TABLE \`notification_outbox_events\` (
        \`id\`             char(36)      NOT NULL,
        \`event_id\`       char(36)      NOT NULL,
        \`aggregate_type\` varchar(80)   NOT NULL,
        \`aggregate_id\`   char(36)      NOT NULL,
        \`event_type\`     varchar(120)  NOT NULL,
        \`payload\`        json          NOT NULL,
        \`status\`         varchar(20)   NOT NULL DEFAULT 'PENDING',
        \`created_at\`     datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`published_at\`   datetime(6)   NULL,
        \`failed_at\`      datetime(6)   NULL,
        \`retry_count\`    int unsigned  NOT NULL DEFAULT 0,
        \`next_retry_at\`  datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`last_error\`     varchar(1000) NULL,
        \`locked_until\`   datetime(6)   NULL,
        \`claim_token\`    char(36)      NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_notification_outbox_event_id\` (\`event_id\`),
        INDEX \`idx_notification_outbox_pending\` (\`status\`, \`next_retry_at\`, \`created_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `notification_outbox_events`');
    await queryRunner.query('DROP TABLE `notification_inbox_events`');
    await queryRunner.query('DROP TABLE `notification_preferences`');
    await queryRunner.query('DROP TABLE `notification_attempts`');
    await queryRunner.query('DROP TABLE `notifications`');
  }
}
