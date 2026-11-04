import { MigrationInterface, QueryRunner } from "typeorm";

export class OrderSchemaChanges1793294329083 implements MigrationInterface {
    name = 'OrderSchemaChanges1793294329083'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`orders\` (\`id\` char(36) NOT NULL, \`customer_id\` varchar(64) NOT NULL, \`idempotency_key\` varchar(128) NOT NULL, \`status\` varchar(40) NOT NULL DEFAULT 'PENDING', \`currency\` char(3) NOT NULL, \`subtotal_amount\` decimal(19,4) NOT NULL, \`total_amount\` decimal(19,4) NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`version\` int UNSIGNED NOT NULL, INDEX \`idx_orders_status_created_at\` (\`status\`, \`created_at\`), INDEX \`idx_orders_customer_created_at\` (\`customer_id\`, \`created_at\`), UNIQUE INDEX \`uq_orders_customer_idempotency\` (\`customer_id\`, \`idempotency_key\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`order_item_entity\` (\`id\` char(36) NOT NULL, \`product_id\` varchar(64) NOT NULL, \`product_name\` varchar(255) NOT NULL, \`quantity\` int UNSIGNED NOT NULL, \`unit_price\` decimal(19,4) NOT NULL, \`line_total\` decimal(19,4) NOT NULL, \`order_id\` char(36) NOT NULL, INDEX \`idx_order_items_product_id\` (\`product_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`order_item_entity\` ADD CONSTRAINT \`FK_3fc9facca59c33ee8dcc5a88171\` FOREIGN KEY (\`order_id\`) REFERENCES \`orders\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`order_item_entity\` DROP FOREIGN KEY \`FK_3fc9facca59c33ee8dcc5a88171\``);
        await queryRunner.query(`DROP INDEX \`idx_order_items_product_id\` ON \`order_item_entity\``);
        await queryRunner.query(`DROP TABLE \`order_item_entity\``);
        await queryRunner.query(`DROP INDEX \`uq_orders_customer_idempotency\` ON \`orders\``);
        await queryRunner.query(`DROP INDEX \`idx_orders_customer_created_at\` ON \`orders\``);
        await queryRunner.query(`DROP INDEX \`idx_orders_status_created_at\` ON \`orders\``);
        await queryRunner.query(`DROP TABLE \`orders\``);
    }

}
