import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  loadSagaTimeoutConfig,
  SAGA_TIMEOUT_CONFIG,
} from './config/saga-timeout.config';
import { InboxEventEntity } from '../inbox/inbox-event.entity';
import { OrderEntity } from '../entities/order.entity';
import { OutboxEventEntity } from '../entities/outbox-event.entity';
import { InventoryResultConsumer } from './consumers/inventory-result.consumer';
import { PaymentResultConsumer } from './consumers/payment-result.consumer';
import { InventoryReleaseResultConsumer } from './consumers/inventory-release-result.consumer';
import { PaymentCompensationResultConsumer } from './consumers/payment-compensation-result.consumer';
import { OrderSagaEntity } from './entities/order-saga.entity';
import { SagaStepEntity } from './entities/saga-step.entity';
import { SagaRabbitMqConsumer } from './consumers/saga-rabbitmq.consumer';
import { SagaOrchestratorService } from './saga-orchestrator.service';
import { SagaCompensationService } from './services/saga-compensation.service';
import { SagaInitializerService } from './services/saga-initializer.service';
import { SagaRecoveryService } from './services/saga-recovery.service';
import { OrdersModule } from '../orders/orders.module';
import { OrderConfirmationService } from './confirmation/order-confirmation.service';
import { OrderConfirmationValidator } from './confirmation/order-confirmation.validator';
import { PaymentResultProcessor } from './confirmation/payment-result.processor';
import { CompensationPolicyService } from './compensation/compensation-policy.service';
import { CompensationStateValidator } from './compensation/compensation-state.validator';
import { CompensationOrchestratorService } from './compensation/compensation-orchestrator.service';
import { OrderConfirmationMetricsService } from './confirmation/order-confirmation-metrics.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InboxEventEntity,
      OrderEntity,
      OrderSagaEntity,
      OutboxEventEntity,
      SagaStepEntity,
    ]),
    OrdersModule,
  ],
  providers: [
    {
      provide: SAGA_TIMEOUT_CONFIG,
      useFactory: () => loadSagaTimeoutConfig(process.env),
    },
    OrderConfirmationService,
    OrderConfirmationValidator,
    OrderConfirmationMetricsService,
    PaymentResultProcessor,
    CompensationPolicyService,
    CompensationStateValidator,
    CompensationOrchestratorService,
    SagaCompensationService,
    SagaInitializerService,
    SagaOrchestratorService,
    SagaRecoveryService,
    InventoryResultConsumer,
    PaymentResultConsumer,
    InventoryReleaseResultConsumer,
    PaymentCompensationResultConsumer,
    SagaRabbitMqConsumer,
  ],
  exports: [
    SAGA_TIMEOUT_CONFIG,
    SagaInitializerService,
    SagaOrchestratorService,
    SagaRecoveryService,
  ],
})
export class SagaModule {}
