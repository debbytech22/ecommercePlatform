import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class BearerTokenGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly tokenName: 'CATALOG_ADMIN_TOKEN',
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();

    const authorization = request.headers.authorization;
    const suppliedToken =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice(7)
        : '';

    const expectedToken = this.config.get<string>(this.tokenName);

    if (!expectedToken || !suppliedToken) {
      throw new UnauthorizedException();
    }

    const supplied = Buffer.from(suppliedToken, 'utf8');
    const expected = Buffer.from(expectedToken, 'utf8');

    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new UnauthorizedException();
    }

    return true;
  }
}

@Injectable()
export class CatalogAdminTokenGuard extends BearerTokenGuard {
  constructor(config: ConfigService) {
    super(config, 'CATALOG_ADMIN_TOKEN');
  }
}
