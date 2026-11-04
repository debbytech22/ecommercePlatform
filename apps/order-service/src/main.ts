
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  MicroserviceOptions,
  Transport,
} from '@nestjs/microservices';
import { join } from 'node:path';

import { OrderServiceModule } from './order-service.module';

const logger = new Logger('OrderServiceBootstrap');

async function bootstrap(): Promise<void> {
  // Start the Order Service independently of the API gateway and other apps.
  const app =
    await NestFactory.createMicroservice<MicroserviceOptions>(
      OrderServiceModule,
      {
        transport: Transport.GRPC,
        options: {
          // This package must match the declaration in order.proto.
          package: 'ecommerce.orders.v1',

          // This path must match the actual location of the copied proto asset.
          protoPath: join(__dirname, 'proto', 'order.proto'),

          // Bind to all interfaces so other containers can reach the service
          // when Docker networking and port exposure are configured correctly.
          url: '0.0.0.0:50051',
        },
      },
    );

  // Nest resolves the service's dependencies before the server begins listening.
  await app.listen();

  logger.log('Order Service gRPC server listening on port 50051');
}

// Fail startup visibly rather than silently leaving the service unavailable.
void bootstrap().catch((error: unknown) => {
  logger.error(
    'Order Service failed to start',
    error instanceof Error ? error.stack : String(error),
  );

  process.exitCode = 1;
});
