import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { PaymentAuthorizedEvent } from 'default/contracts';
import { OrderConfirmationService } from './order-confirmation.service';
import type { OrderConfirmationResult } from './order-confirmation-metrics.service';

@Injectable()
export class PaymentResultProcessor {
  constructor(private readonly confirmation: OrderConfirmationService) {}

  processAuthorization(
    manager: EntityManager,
    event: PaymentAuthorizedEvent,
  ): Promise<OrderConfirmationResult> {
    return this.confirmation.confirmOrder(
      event.payload.orderId,
      event,
      manager,
    );
  }
}
