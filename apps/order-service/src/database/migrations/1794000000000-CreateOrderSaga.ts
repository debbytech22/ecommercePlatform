import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrderSaga1794000000000 implements MigrationInterface {
  name = 'CreateOrderSaga1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `order_sagas` (`id` char(36) NOT NULL, `order_id` char(36) NOT NULL, `state` varchar(40) NOT NULL, `correlation_id` char(36) NOT NULL, `reservation_id` char(36) NULL, `last_error` varchar(1000) NULL, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_order_sagas_order_id` (`order_id`), INDEX `idx_order_sagas_recovery` (`state`, `updated_at`), PRIMARY KEY (`id`)) ENGINE=InnoDB',
    );
    await queryRunner.query(
      'CREATE TABLE `saga_steps` (`id` char(36) NOT NULL, `saga_id` char(36) NOT NULL, `step_type` varchar(40) NOT NULL, `status` varchar(40) NOT NULL, `attempts` int UNSIGNED NOT NULL DEFAULT 0, `last_error` varchar(1000) NULL, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_saga_steps_saga_type` (`saga_id`, `step_type`), INDEX `idx_saga_steps_status_updated_at` (`status`, `updated_at`), PRIMARY KEY (`id`)) ENGINE=InnoDB',
    );
    await queryRunner.query(
      'CREATE TABLE `order_inbox_events` (`event_id` char(36) NOT NULL, `event_type` varchar(120) NOT NULL, `aggregate_id` char(36) NOT NULL, `correlation_id` char(36) NOT NULL, `received_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `processed_at` datetime(6) NULL, INDEX `idx_order_inbox_processed_at` (`processed_at`), PRIMARY KEY (`event_id`)) ENGINE=InnoDB',
    );
    await queryRunner.query(
      'ALTER TABLE `order_sagas` ADD CONSTRAINT `fk_order_sagas_order_id` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE `saga_steps` ADD CONSTRAINT `fk_saga_steps_saga_id` FOREIGN KEY (`saga_id`) REFERENCES `order_sagas`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `saga_steps` DROP FOREIGN KEY `fk_saga_steps_saga_id`',
    );
    await queryRunner.query(
      'ALTER TABLE `order_sagas` DROP FOREIGN KEY `fk_order_sagas_order_id`',
    );
    await queryRunner.query('DROP TABLE `order_inbox_events`');
    await queryRunner.query('DROP TABLE `saga_steps`');
    await queryRunner.query('DROP TABLE `order_sagas`');
  }
}
