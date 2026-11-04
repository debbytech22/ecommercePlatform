import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductEntity } from './product.entity';
import { CatalogService } from './catalog-service.service';
import { CatalogController } from './catalog-service.controller';
import { CatalogGrpcController } from './catalog-grpc.controller';
import { getCatalogDatabaseOptions } from './config/database-options';
import { CatalogAdminTokenGuard } from './auth/bearer-token.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      useFactory: () => getCatalogDatabaseOptions(process.env),
    }),
    TypeOrmModule.forFeature([ProductEntity]),
  ],
  controllers: [CatalogController, CatalogGrpcController],
  providers: [CatalogService, CatalogAdminTokenGuard],
})
export class CatalogServiceModule {}
