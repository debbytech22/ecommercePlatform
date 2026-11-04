import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePaymentSchema1794200000000 implements MigrationInterface {
  name = 'CreatePaymentSchema1794200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `payments` (`id` char(36) NOT NULL, `order_id` char(36) NOT NULL, `customer_id` varchar(64) NOT NULL, `status` varchar(40) NOT NULL, `currency` char(3) NOT NULL, `amount` decimal(19,4) unsigned NOT NULL, `authorized_amount` decimal(19,4) unsigned NOT NULL DEFAULT 0, `captured_amount` decimal(19,4) unsigned NOT NULL DEFAULT 0, `refunded_amount` decimal(19,4) unsigned NOT NULL DEFAULT 0, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_payments_order_id` (`order_id`), INDEX `idx_payments_status_updated_at` (`status`, `updated_at`), PRIMARY KEY (`id`), CONSTRAINT `chk_payments_amounts` CHECK (`amount` > 0 AND `authorized_amount` <= `amount` AND `captured_amount` <= `authorized_amount` AND `refunded_amount` <= `captured_amount`)) ENGINE=InnoDB',
    );
    await queryRunner.query(
      'CREATE TABLE `payment_operations` (`id` char(36) NOT NULL, `payment_id` char(36) NOT NULL, `order_id` char(36) NOT NULL, `operation_id` char(36) NOT NULL, `authorization_operation_id` char(36) NULL, `command_id` char(36) NOT NULL, `idempotency_key` varchar(128) NOT NULL, `operation_type` varchar(32) NOT NULL, `operation_status` varchar(32) NOT NULL, `amount` decimal(19,4) unsigned NULL, `provider_reference` varchar(255) NULL, `failure_code` varchar(100) NULL, `failure_reason` varchar(1000) NULL, `processing_lease_until` datetime(6) NULL, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_payment_operations_operation_id` (`operation_id`), UNIQUE INDEX `uq_payment_operations_command_id` (`command_id`), UNIQUE INDEX `uq_payment_operations_idempotency_key` (`idempotency_key`), UNIQUE INDEX `uq_payment_operations_provider_reference` (`provider_reference`), INDEX `idx_payment_operations_payment_type` (`payment_id`, `operation_type`), PRIMARY KEY (`id`), CONSTRAINT `chk_payment_operations_amount` CHECK (`amount` IS NULL OR `amount` > 0), CONSTRAINT `fk_payment_operations_payment` FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ON DELETE RESTRICT ON UPDATE NO ACTION) ENGINE=InnoDB',
    );
    await queryRunner.query(
      'CREATE TABLE `payment_transactions` (`id` char(36) NOT NULL, `payment_id` char(36) NOT NULL, `operation_id` char(36) NOT NULL, `provider_reference` varchar(255) NULL, `transaction_type` varchar(32) NOT NULL, `status` varchar(32) NOT NULL, `amount` decimal(19,4) unsigned NOT NULL, `currency` char(3) NOT NULL, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_payment_transactions_provider_reference` (`provider_reference`), INDEX `idx_payment_transactions_payment_created_at` (`payment_id`, `created_at`), PRIMARY KEY (`id`), CONSTRAINT `chk_payment_transactions_amount` CHECK (`amount` > 0), CONSTRAINT `fk_payment_transactions_payment` FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ON DELETE RESTRICT ON UPDATE NO ACTION, CONSTRAINT `fk_payment_transactions_operation` FOREIGN KEY (`operation_id`) REFERENCES `payment_operations` (`operation_id`) ON DELETE RESTRICT ON UPDATE NO ACTION) ENGINE=InnoDB',
    );
    await queryRunner.query(
      'CREATE TABLE `payment_inbox_events` (`id` char(36) NOT NULL, `event_id` char(36) NOT NULL, `event_type` varchar(120) NOT NULL, `aggregate_id` char(36) NOT NULL, `correlation_id` char(36) NOT NULL, `processing_status` varchar(20) NOT NULL, `received_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `processed_at` datetime(6) NULL, UNIQUE INDEX `uq_payment_inbox_event_id` (`event_id`), INDEX `idx_payment_inbox_status_received` (`processing_status`, `received_at`), PRIMARY KEY (`id`)) ENGINE=InnoDB',
    );
    await queryRunner.query(
      "CREATE TABLE `payment_outbox_events` (`id` char(36) NOT NULL, `event_id` char(36) NOT NULL, `aggregate_type` varchar(80) NOT NULL, `aggregate_id` char(36) NOT NULL, `event_type` varchar(120) NOT NULL, `payload` json NOT NULL, `status` varchar(20) NOT NULL DEFAULT 'PENDING', `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `published_at` datetime(6) NULL, `failed_at` datetime(6) NULL, `retry_count` int unsigned NOT NULL DEFAULT 0, `next_retry_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `last_error` varchar(1000) NULL, `locked_until` datetime(6) NULL, `claim_token` char(36) NULL, UNIQUE INDEX `uq_payment_outbox_event_id` (`event_id`), INDEX `idx_payment_outbox_pending` (`status`, `next_retry_at`, `created_at`), PRIMARY KEY (`id`)) ENGINE=InnoDB",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `payment_outbox_events`');
    await queryRunner.query('DROP TABLE `payment_inbox_events`');
    await queryRunner.query('DROP TABLE `payment_transactions`');
    await queryRunner.query('DROP TABLE `payment_operations`');
    await queryRunner.query('DROP TABLE `payments`');
  }
}
