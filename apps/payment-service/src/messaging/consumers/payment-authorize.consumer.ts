import { Injectable } from '@nestjs/common';
import { PaymentCommandConsumer } from './payment-command-consumer';

@Injectable()
export class PaymentAuthorizeConsumer {
  constructor(private readonly commands: PaymentCommandConsumer) {}

  consume(command: unknown): Promise<'processed' | 'duplicate'> {
    return this.commands.consume(command);
  }
}
