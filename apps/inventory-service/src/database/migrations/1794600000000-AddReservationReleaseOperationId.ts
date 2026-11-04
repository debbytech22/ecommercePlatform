import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReservationReleaseOperationId1794600000000 implements MigrationInterface {
  name = 'AddReservationReleaseOperationId1794600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `inventory_reservations` ADD `release_operation_id` char(36) NULL',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX `uq_inventory_reservations_release_operation_id` ON `inventory_reservations` (`release_operation_id`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `uq_inventory_reservations_release_operation_id` ON `inventory_reservations`',
    );
    await queryRunner.query(
      'ALTER TABLE `inventory_reservations` DROP COLUMN `release_operation_id`',
    );
  }
}
