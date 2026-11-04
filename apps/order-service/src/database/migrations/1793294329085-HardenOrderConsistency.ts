import { MigrationInterface, QueryRunner } from 'typeorm';

export class HardenOrderConsistency1793294329085 implements MigrationInterface {
  name = 'HardenOrderConsistency1793294329085';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `orders` ADD CONSTRAINT `chk_orders_customer_id_nonempty` CHECK (CHAR_LENGTH(TRIM(`customer_id`)) > 0)',
    );
    await queryRunner.query(
      'ALTER TABLE `orders` ADD CONSTRAINT `chk_orders_idempotency_key_length` CHECK (CHAR_LENGTH(`idempotency_key`) BETWEEN 16 AND 128)',
    );
    await queryRunner.query(
      "ALTER TABLE `orders` ADD CONSTRAINT `chk_orders_request_hash_format` CHECK (`request_hash` IS NULL OR `request_hash` REGEXP '^[0-9a-f]{64}$')",
    );
    await queryRunner.query(
      'ALTER TABLE `orders` ADD CONSTRAINT `chk_orders_amounts_nonnegative` CHECK (`subtotal_amount` >= 0 AND `total_amount` >= 0)',
    );
    await queryRunner.query(
      'ALTER TABLE `order_item_entity` ADD CONSTRAINT `chk_order_items_quantity_range` CHECK (`quantity` BETWEEN 1 AND 1000)',
    );
    await queryRunner.query(
      'ALTER TABLE `order_item_entity` ADD CONSTRAINT `chk_order_items_amounts_nonnegative` CHECK (`unit_price` >= 0 AND `line_total` >= 0)',
    );
    await queryRunner.query(
      'ALTER TABLE `order_item_entity` ADD CONSTRAINT `chk_order_items_line_total_matches_quantity` CHECK (`line_total` = `unit_price` * `quantity`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `order_item_entity` DROP CHECK `chk_order_items_line_total_matches_quantity`',
    );
    await queryRunner.query(
      'ALTER TABLE `order_item_entity` DROP CHECK `chk_order_items_amounts_nonnegative`',
    );
    await queryRunner.query(
      'ALTER TABLE `order_item_entity` DROP CHECK `chk_order_items_quantity_range`',
    );
    await queryRunner.query(
      'ALTER TABLE `orders` DROP CHECK `chk_orders_amounts_nonnegative`',
    );
    await queryRunner.query(
      'ALTER TABLE `orders` DROP CHECK `chk_orders_request_hash_format`',
    );
    await queryRunner.query(
      'ALTER TABLE `orders` DROP CHECK `chk_orders_idempotency_key_length`',
    );
    await queryRunner.query(
      'ALTER TABLE `orders` DROP CHECK `chk_orders_customer_id_nonempty`',
    );
  }
}
