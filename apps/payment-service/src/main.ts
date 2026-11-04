import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { PaymentServiceModule } from './payment-service.module';

const logger = new Logger('PaymentServiceBootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(PaymentServiceModule);
  const port = Number(process.env.PAYMENT_SERVICE_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PAYMENT_SERVICE_PORT must be between 1 and 65535');
  }
  await app.listen(port);
  logger.log(`Payment Service listening on port ${port}`);
}

void bootstrap().catch((error: unknown) => {
  logger.error(
    'Payment Service failed to start',
    error instanceof Error ? error.stack : String(error),
  );
  process.exitCode = 1;
});
