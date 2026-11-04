import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReleasedReservationStatus1793900000000 implements MigrationInterface {
  name = 'AddReleasedReservationStatus1793900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `inventory_reservations` DROP CHECK `chk_inventory_reservation_status`',
    );
    await queryRunner.query(
      "ALTER TABLE `inventory_reservations` ADD CONSTRAINT `chk_inventory_reservation_status` CHECK (`status` IN ('RESERVED', 'FAILED', 'RELEASED'))",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ released_count: releasedCount }] = (await queryRunner.query(
      "SELECT COUNT(*) AS `released_count` FROM `inventory_reservations` WHERE `status` = 'RELEASED'",
    )) as Array<{ released_count: number | string }>;
    if (Number(releasedCount) > 0) {
      throw new Error(
        'Cannot remove RELEASED reservation status while released reservations exist',
      );
    }
    await queryRunner.query(
      'ALTER TABLE `inventory_reservations` DROP CHECK `chk_inventory_reservation_status`',
    );
    await queryRunner.query(
      "ALTER TABLE `inventory_reservations` ADD CONSTRAINT `chk_inventory_reservation_status` CHECK (`status` IN ('RESERVED', 'FAILED'))",
    );
  }
}
