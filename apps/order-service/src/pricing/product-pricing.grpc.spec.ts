import { Metadata, status } from '@grpc/grpc-js';
import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import type { ClientGrpc } from '@nestjs/microservices';
import { of } from 'rxjs';

import { ProductPricingGrpcClient } from './product-pricing.grpc';

describe('ProductPricingGrpcClient', () => {
  it('sends service credentials and a gRPC deadline', async () => {
    const getPrices = jest.fn().mockReturnValue(
      of({
        items: [
          {
            productId: 'product-1',
            productName: 'Product',
            unitPrice: '1.0000',
            currency: 'USD',
            active: true,
          },
        ],
      }),
    );
    const client = {
      getService: jest.fn().mockReturnValue({ GetPrices: getPrices }),
    } as unknown as ClientGrpc;
    const config = {
      get: jest.fn().mockReturnValue('service-secret'),
    };
    const pricing = new ProductPricingGrpcClient(
      client,
      config as unknown as ConfigService,
    );

    pricing.onModuleInit();
    await expect(pricing.getPrices(['product-1'])).resolves.toHaveLength(1);

    const [, metadata, options] = getPrices.mock.calls[0] as [
      unknown,
      Metadata,
      { deadline: Date },
    ];
    expect(metadata.get('x-catalog-service-token')).toEqual(['service-secret']);
    expect(options.deadline.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not call catalog if service credentials are missing', async () => {
    const getPrices = jest.fn();
    const client = {
      getService: jest.fn().mockReturnValue({ GetPrices: getPrices }),
    } as unknown as ClientGrpc;
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    };
    const pricing = new ProductPricingGrpcClient(
      client,
      config as unknown as ConfigService,
    );

    pricing.onModuleInit();

    try {
      await pricing.getPrices(['product-1']);
      throw new Error('Expected pricing lookup to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      if (error instanceof RpcException) {
        expect(error.getError()).toMatchObject({
          code: status.UNAVAILABLE,
        });
      }
    }

    expect(getPrices).not.toHaveBeenCalled();
  });
});
