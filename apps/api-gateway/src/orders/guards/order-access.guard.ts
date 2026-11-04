import {
  CanActivate,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AuthenticatedRequest extends Request {
  user: { customerId: string };
}

interface JwtHeader {
  alg?: unknown;
  typ?: unknown;
}

interface JwtClaims {
  sub?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

@Injectable()
export class OrderAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const bearerMatch =
      typeof authorization === 'string'
        ? /^Bearer\s+(.+)$/i.exec(authorization)
        : null;
    const token = bearerMatch?.[1] ?? '';
    if (!token) throw new UnauthorizedException('Valid bearer token required');
    if (token.length > 8192) {
      throw new UnauthorizedException('Invalid bearer token');
    }

    const secret = process.env.CUSTOMER_JWT_SECRET;
    const issuer = process.env.CUSTOMER_JWT_ISSUER;
    const audience = process.env.CUSTOMER_JWT_AUDIENCE;
    if (
      !secret ||
      Buffer.byteLength(secret, 'utf8') < 32 ||
      !issuer ||
      !audience
    ) {
      throw new ServiceUnavailableException(
        'Customer authentication is not configured',
      );
    }

    const claims = this.verifyToken(token, secret);
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.iss !== issuer ||
      !this.hasAudience(claims.aud, audience) ||
      typeof claims.exp !== 'number' ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= now ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== 'number' ||
          !Number.isSafeInteger(claims.nbf) ||
          claims.nbf > now + 30)) ||
      typeof claims.sub !== 'string' ||
      claims.sub.trim().length === 0 ||
      claims.sub.length > 64
    ) {
      throw new UnauthorizedException('Invalid or expired bearer token');
    }

    request.user = { customerId: claims.sub.trim() };
    return true;
  }

  private verifyToken(token: string, secret: string): JwtClaims {
    const parts = token.split('.');
    if (
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    ) {
      throw new UnauthorizedException('Invalid bearer token');
    }

    let header: unknown;
    let claims: unknown;
    try {
      header = JSON.parse(
        Buffer.from(parts[0], 'base64url').toString('utf8'),
      ) as unknown;
      claims = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8'),
      ) as unknown;
    } catch {
      throw new UnauthorizedException('Invalid bearer token');
    }
    if (!this.isRecord(header) || !this.isRecord(claims)) {
      throw new UnauthorizedException('Invalid bearer token');
    }
    const tokenHeader = header as JwtHeader;
    if (
      tokenHeader.alg !== 'HS256' ||
      (tokenHeader.typ && tokenHeader.typ !== 'JWT')
    ) {
      throw new UnauthorizedException('Unsupported bearer token');
    }

    const expected = createHmac('sha256', secret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest();
    const supplied = Buffer.from(parts[2], 'base64url');
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new UnauthorizedException('Invalid bearer token');
    }
    return claims as JwtClaims;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private hasAudience(value: unknown, expected: string): boolean {
    return (
      value === expected ||
      (Array.isArray(value) &&
        value.every((entry) => typeof entry === 'string') &&
        value.includes(expected))
    );
  }
}

@Injectable()
export class OrderRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<
    string,
    { startedAt: number; count: number }
  >();
  private readonly durationMs = 60_000;
  private readonly maxRequests = 60;
  private readonly maxTrackedCustomers = 10_000;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const customerId = request.user?.customerId;
    if (!customerId) throw new UnauthorizedException();

    const now = Date.now();
    if (this.buckets.size >= this.maxTrackedCustomers) {
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.startedAt >= this.durationMs) {
          this.buckets.delete(key);
        }
      }
    }

    let bucket = this.buckets.get(customerId);
    if (!bucket || now - bucket.startedAt >= this.durationMs) {
      if (!bucket && this.buckets.size >= this.maxTrackedCustomers) {
        throw new HttpException(
          'Order query rate limit capacity is temporarily full',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      bucket = { startedAt: now, count: 0 };
      this.buckets.set(customerId, bucket);
    }
    bucket.count += 1;
    if (bucket.count > this.maxRequests) {
      throw new HttpException(
        'Order query rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
