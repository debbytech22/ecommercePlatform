import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentEntity } from './entities/payment.entity';
import { PaymentOperationEntity } from './entities/payment-operation.entity';
import { PaymentTransactionEntity } from './entities/payment-transaction.entity';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PaymentEntity,
      PaymentOperationEntity,
      PaymentTransactionEntity,
    ]),
  ],
  providers: [PaymentsRepository, PaymentsService],
  exports: [PaymentsRepository, PaymentsService],
})
export class PaymentsModule {}
