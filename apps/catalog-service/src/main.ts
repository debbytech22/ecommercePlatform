import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { NestFactory } from '@nestjs/core';
import { join } from 'node:path';
import { CatalogServiceModule } from './catalog-service.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(CatalogServiceModule);
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'ecommerce.catalog.v1',
      protoPath: join(__dirname, 'proto', 'catalog.proto'),
      url: process.env.CATALOG_GRPC_BIND_URL ?? '0.0.0.0:50052',
    },
  });

  await app.startAllMicroservices();
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap().catch((error: unknown) => {
  console.error(
    'Catalog Service failed to start',
    error instanceof Error ? error.stack : String(error),
  );
  process.exitCode = 1;
});
