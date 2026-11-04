import { Metadata, status } from '@grpc/grpc-js';
import { Controller, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { timingSafeEqual } from 'node:crypto';

import type { GetPricesRequest, GetPricesResponse } from 'default/contracts';

import { CatalogService } from './catalog-service.service';

@Controller()
export class CatalogGrpcController {
  private readonly logger = new Logger(CatalogGrpcController.name);

  constructor(
    private readonly catalog: CatalogService,
    private readonly config: ConfigService,
  ) {}

  @GrpcMethod('CatalogService', 'GetPrices')
  async getPrices(
    request: GetPricesRequest,
    metadata: Metadata,
  ): Promise<GetPricesResponse> {
    this.requireServiceToken(metadata);

    const productIds = request?.productIds;

    if (
      !Array.isArray(productIds) ||
      productIds.length < 1 ||
      productIds.length > 50 ||
      productIds.some(
        (productId) =>
          typeof productId !== 'string' ||
          !/^[A-Za-z0-9._:-]{1,64}$/.test(productId),
      )
    ) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'Between 1 and 50 valid product IDs are required',
      });
    }

    const result = await this.catalog.getPrices(productIds);
    return { items: result.items };
  }

  private requireServiceToken(metadata: Metadata): void {
    const expectedToken = this.config.get<string>('CATALOG_SERVICE_TOKEN');
    const suppliedValue = metadata.get('x-catalog-service-token')[0];

    if (
      !expectedToken ||
      typeof suppliedValue !== 'string' ||
      suppliedValue.length === 0
    ) {
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Catalog service credentials are required',
      });
    }

    const supplied = Buffer.from(suppliedValue, 'utf8');
    const expected = Buffer.from(expectedToken, 'utf8');

    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      this.logger.warn(
        'Rejected catalog gRPC request with invalid credentials',
      );
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Catalog service credentials are invalid',
      });
    }
  }
}
