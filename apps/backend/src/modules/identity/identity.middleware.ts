import { Injectable, NestMiddleware } from '@nestjs/common';
import { getSession } from '@auth/express';
import type { NextFunction, Request, Response } from 'express';
import { authConfig } from '../../auth/auth.config';
import { IdentityService } from './identity.service';

declare module 'express' {
  interface Request {
    user?: Awaited<ReturnType<IdentityService['getOrCreateUser']>>;
  }
}

@Injectable()
export class IdentityMiddleware implements NestMiddleware {
  constructor(private readonly identity: IdentityService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const session = await getSession(req, authConfig);
    if (!session?.user) return next();             // anonymous; let the route decide

    const externalId = (session.user as { id?: string }).id;
    const email = session.user.email;
    if (!externalId || !email) return next();

    req.user = await this.identity.getOrCreateUser({
      externalId,
      email,
      displayName: session.user.name ?? null,
      avatarUrl: (session.user as { image?: string }).image ?? null,
    });
    next();
  }
}