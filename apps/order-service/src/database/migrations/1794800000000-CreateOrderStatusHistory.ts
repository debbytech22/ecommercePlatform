import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrderStatusHistory1794800000000 implements MigrationInterface {
  name = 'CreateOrderStatusHistory1794800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `order_status_history` (`id` char(36) NOT NULL, `order_id` char(36) NOT NULL, `sequence_number` int unsigned NOT NULL, `from_status` varchar(40) NULL, `to_status` varchar(40) NOT NULL, `reason_code` varchar(100) NULL, `reason` varchar(255) NULL, `correlation_id` char(36) NULL, `causation_id` char(36) NULL, `occurred_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_order_status_history_order_sequence` (`order_id`, `sequence_number`), INDEX `idx_order_status_history_order_id` (`order_id`, `occurred_at`), PRIMARY KEY (`id`), CONSTRAINT `fk_order_status_history_order_id` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION) ENGINE=InnoDB',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `order_status_history`');
  }
}
