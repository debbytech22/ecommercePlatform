import { Metadata, status } from '@grpc/grpc-js';
import  { CallOptions } from '@grpc/grpc-js';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import type { ClientGrpc } from '@nestjs/microservices';
import  { GetPricesRequest, GetPricesResponse } from 'default/contracts';
import { firstValueFrom, Observable, timeout } from 'rxjs';

import type { ProductPrice, ProductPricingPort } from './product-pricing.port';

export const CATALOG_GRPC_CLIENT = 'CATALOG_GRPC_CLIENT';

interface CatalogGrpcClient {
  GetPrices(
    request: GetPricesRequest,
    metadata: Metadata,
    options?: CallOptions,
  ): Observable<GetPricesResponse>;
}

const CATALOG_REQUEST_TIMEOUT_MS = 3000;

@Injectable()
export class ProductPricingGrpcClient
  implements ProductPricingPort, OnModuleInit
{
  private catalog!: CatalogGrpcClient;

  
  constructor(
    @Inject(CATALOG_GRPC_CLIENT)
    private readonly client: ClientGrpc,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.catalog = this.client.getService<CatalogGrpcClient>('CatalogService');
  }

  async getPrices(productIds: string[]): Promise<ProductPrice[]> {
    const serviceToken = this.config.get<string>('CATALOG_SERVICE_TOKEN');

    if (!serviceToken) {
      throw new RpcException({
        code: status.UNAVAILABLE,
        message: 'Trusted product pricing is not configured',
      });
    }

    const metadata = new Metadata();
    metadata.set('x-catalog-service-token', serviceToken);

    let response: GetPricesResponse;
    try {
      const deadline = new Date(Date.now() + CATALOG_REQUEST_TIMEOUT_MS);
      response = await firstValueFrom(
        this.catalog
          .GetPrices({ productIds }, metadata, { deadline })
          .pipe(timeout({ first: CATALOG_REQUEST_TIMEOUT_MS + 250 })),
      );
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }

      const errorCode =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'number'
          ? error.code
          : undefined;

      if (errorCode === status.UNAUTHENTICATED) {
        throw new RpcException({
          code: status.UNAUTHENTICATED,
          message: 'Catalog rejected the service credentials',
        });
      }

      if (errorCode === status.DEADLINE_EXCEEDED) {
        throw new RpcException({
          code: status.DEADLINE_EXCEEDED,
          message: 'Catalog pricing request exceeded its deadline',
        });
      }

      throw new RpcException({
        code: status.UNAVAILABLE,
        message: 'Trusted product pricing is temporarily unavailable',
      });
    }

    if (
      !response ||
      !Array.isArray(response.items) ||
      response.items.some(
        (item) =>
          !item ||
          typeof item.productId !== 'string' ||
          typeof item.productName !== 'string' ||
          typeof item.unitPrice !== 'string' ||
          typeof item.currency !== 'string' ||
          typeof item.active !== 'boolean',
      )
    ) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Catalog returned an invalid pricing response',
      });
    }

    return response.items.map((item) => {
      if (
        !item.productId.trim() ||
        !item.productName.trim() ||
        !/^(0|[1-9]\d{0,14})(\.\d{1,4})?$/.test(item.unitPrice) ||
        !/^[A-Z]{3}$/.test(item.currency)
      ) {
        throw new RpcException({
          code: status.FAILED_PRECONDITION,
          message: 'Catalog returned invalid product data',
        });
      }

      return {
        productId: item.productId,
        productName: item.productName,
        unitPrice: item.unitPrice,
        currency: item.currency,
        active: item.active,
      };
    });
  }
}
