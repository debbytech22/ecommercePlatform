import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderPaymentConfirmation1794300000000 implements MigrationInterface {
  name = 'AddOrderPaymentConfirmation1794300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `order_sagas` ADD `payment_id` char(36) NULL, ADD `payment_amount` decimal(19,4) NULL, ADD `payment_currency` char(3) NULL, ADD `payment_status` varchar(20) NULL, ADD `inventory_reservation_status` varchar(20) NULL, ADD `inventory_reservation_items` json NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `order_sagas` DROP COLUMN `inventory_reservation_items`, DROP COLUMN `inventory_reservation_status`, DROP COLUMN `payment_status`, DROP COLUMN `payment_currency`, DROP COLUMN `payment_amount`, DROP COLUMN `payment_id`',
    );
  }
}
