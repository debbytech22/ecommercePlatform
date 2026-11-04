import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCatalogProducts1793380000000 implements MigrationInterface {
  name = 'CreateCatalogProducts1793380000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `catalog_products` (`id` varchar(36) NOT NULL, `product_id` varchar(64) NOT NULL, `product_name` varchar(255) NOT NULL, `unit_price` decimal(19,4) NOT NULL, `currency` char(3) NOT NULL, `active` tinyint NOT NULL DEFAULT 1, `version` int UNSIGNED NOT NULL DEFAULT 1, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_catalog_product_id` (`product_id`), INDEX `idx_catalog_active` (`active`), PRIMARY KEY (`id`)) ENGINE=InnoDB',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `catalog_products`');
  }
}
