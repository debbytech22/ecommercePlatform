import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getPaymentDatabaseOptions } from './database/database-options';
import { InboxModule } from './inbox/inbox.module';
import { MessagingModule } from './messaging/messaging.module';
import { OperationsModule } from './operations/operations.module';
import { OutboxModule } from './outbox/outbox.module';
import { PaymentsModule } from './payments/payments.module';
import { PaymentProviderModule } from './providers/payment-provider.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { PaymentServiceController } from './payment-service.controller';
import { PaymentServiceService } from './payment-service.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      useFactory: () => getPaymentDatabaseOptions(process.env),
    }),
    PaymentsModule,
    OperationsModule,
    PaymentProviderModule,
    InboxModule,
    OutboxModule,
    ReconciliationModule,
    MessagingModule,
  ],
  controllers: [PaymentServiceController],
  providers: [PaymentServiceService],
})
export class PaymentServiceModule {}
