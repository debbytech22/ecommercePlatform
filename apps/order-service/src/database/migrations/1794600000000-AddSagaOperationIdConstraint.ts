import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSagaOperationIdConstraint1794600000000
  implements MigrationInterface
{
  name = 'AddSagaOperationIdConstraint1794600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE UNIQUE INDEX `uq_saga_steps_operation_id` ON `saga_steps` (`operation_id`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `uq_saga_steps_operation_id` ON `saga_steps`',
    );
  }
}
