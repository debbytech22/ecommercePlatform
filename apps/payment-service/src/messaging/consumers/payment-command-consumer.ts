import { Injectable } from '@nestjs/common';
import { OperationsService } from '../../operations/operations.service';

@Injectable()
export class PaymentCommandConsumer {
  constructor(private readonly operations: OperationsService) {}

  consume(command: unknown): Promise<'processed' | 'duplicate'> {
    return this.operations.process(command);
  }
}
