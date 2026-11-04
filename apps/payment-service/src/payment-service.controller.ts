import { Controller, Get, Header } from '@nestjs/common';
import { OperationsService } from './operations/operations.service';
import { PaymentServiceService } from './payment-service.service';

@Controller()
export class PaymentServiceController {
  constructor(
    private readonly paymentServiceService: PaymentServiceService,
    private readonly operations: OperationsService,
  ) {}

  @Get()
  getHello(): string {
    return this.paymentServiceService.getHello();
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(): Promise<string> {
    return this.operations.getCompensationMetrics();
  }
}
