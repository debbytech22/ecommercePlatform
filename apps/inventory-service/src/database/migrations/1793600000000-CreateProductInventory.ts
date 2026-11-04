import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProductInventory1793600000000 implements MigrationInterface {
  name = 'CreateProductInventory1793600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `product_inventory` (`product_id` varchar(120) NOT NULL, `on_hand` int UNSIGNED NOT NULL DEFAULT 0, `reserved` int UNSIGNED NOT NULL DEFAULT 0, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), PRIMARY KEY (`product_id`), CONSTRAINT `chk_product_inventory_reserved_le_on_hand` CHECK (`reserved` <= `on_hand`)) ENGINE=InnoDB',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `product_inventory`');
  }
}
