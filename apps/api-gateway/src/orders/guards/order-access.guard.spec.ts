import { createHmac } from 'node:crypto';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from './order-access.guard';
import { OrderAccessGuard, OrderRateLimitGuard } from './order-access.guard';

const SECRET = 'a-test-secret-that-is-at-least-32-bytes';

function createToken(claimOverrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'customer-123',
      iss: 'https://identity.example.test',
      aud: 'ecommerce-api',
      exp: Math.floor(Date.now() / 1000) + 60,
      ...claimOverrides,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function contextFor(request: AuthenticatedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('OrderAccessGuard', () => {
  const originalEnvironment = {
    secret: process.env.CUSTOMER_JWT_SECRET,
    issuer: process.env.CUSTOMER_JWT_ISSUER,
    audience: process.env.CUSTOMER_JWT_AUDIENCE,
  };
  const guard = new OrderAccessGuard();

  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = SECRET;
    process.env.CUSTOMER_JWT_ISSUER = 'https://identity.example.test';
    process.env.CUSTOMER_JWT_AUDIENCE = 'ecommerce-api';
  });

  afterAll(() => {
    if (originalEnvironment.secret === undefined) {
      delete process.env.CUSTOMER_JWT_SECRET;
    } else process.env.CUSTOMER_JWT_SECRET = originalEnvironment.secret;
    if (originalEnvironment.issuer === undefined) {
      delete process.env.CUSTOMER_JWT_ISSUER;
    } else process.env.CUSTOMER_JWT_ISSUER = originalEnvironment.issuer;
    if (originalEnvironment.audience === undefined) {
      delete process.env.CUSTOMER_JWT_AUDIENCE;
    } else process.env.CUSTOMER_JWT_AUDIENCE = originalEnvironment.audience;
  });

  it('derives customer identity from a valid, scoped HS256 token', () => {
    const request = {
      headers: { authorization: `Bearer ${createToken()}` },
      user: undefined,
    } as unknown as AuthenticatedRequest;

    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.user).toEqual({ customerId: 'customer-123' });
  });

  it('rejects invalid signatures and mismatched token audiences', () => {
    const [header, payload] = createToken().split('.');
    const tampered = `${header}.${payload}.${Buffer.alloc(32).toString('base64url')}`;
    const badSignatureRequest = {
      headers: { authorization: `Bearer ${tampered}` },
    } as AuthenticatedRequest;
    expect(() => guard.canActivate(contextFor(badSignatureRequest))).toThrow(
      UnauthorizedException,
    );

    const wrongAudienceRequest = {
      headers: {
        authorization: `Bearer ${createToken({ aud: 'other-api' })}`,
      },
    } as AuthenticatedRequest;
    expect(() => guard.canActivate(contextFor(wrongAudienceRequest))).toThrow(
      UnauthorizedException,
    );
  });
});

describe('OrderRateLimitGuard', () => {
  it('limits requests per authenticated customer per fixed window', () => {
    const guard = new OrderRateLimitGuard();
    const request = {
      user: { customerId: 'customer-123' },
    } as AuthenticatedRequest;
    const context = contextFor(request);

    for (let index = 0; index < 60; index += 1) {
      expect(guard.canActivate(context)).toBe(true);
    }
    try {
      guard.canActivate(context);
      throw new Error('Expected the rate limit to reject the request');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    }
  });
});
