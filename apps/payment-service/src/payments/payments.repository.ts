import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaymentEntity } from './entities/payment.entity';
import { PaymentOperationEntity } from './entities/payment-operation.entity';
import { PaymentTransactionEntity } from './entities/payment-transaction.entity';

@Injectable()
export class PaymentsRepository {
  constructor(
    @InjectRepository(PaymentEntity)
    readonly payments: Repository<PaymentEntity>,
    @InjectRepository(PaymentOperationEntity)
    readonly operations: Repository<PaymentOperationEntity>,
    @InjectRepository(PaymentTransactionEntity)
    readonly transactions: Repository<PaymentTransactionEntity>,
  ) {}
}
