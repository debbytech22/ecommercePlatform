import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NotificationServiceModule } from './notification-service.module';

const logger = new Logger('NotificationServiceBootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(NotificationServiceModule);
  const port = Number(process.env.NOTIFICATION_SERVICE_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('NOTIFICATION_SERVICE_PORT must be between 1 and 65535');
  }
  await app.listen(port);
  logger.log(`Notification Service listening on port ${port}`);
}

void bootstrap().catch((error: unknown) => {
  logger.error(
    'Notification Service failed to start',
    error instanceof Error ? error.stack : String(error),
  );
  process.exitCode = 1;
});
