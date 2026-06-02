import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { REQUIRE_ACTION_KEY } from './require-action.decorator.js';
import { can } from './enforcer.js';

@Injectable()
export class ActionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<string>(
      REQUIRE_ACTION_KEY,
      ctx.getHandler(),
    );
    if (!action) return true;

    const req = ctx
      .switchToHttp()
      .getRequest<
        Request & {
          workspace?: { slug: string };
          membership?: { role: string };
        }
      >();
    if (!req.workspace || !req.membership) throw new ForbiddenException();

    const allowed = await can(req.membership.role, req.workspace.slug, action);
    if (!allowed) throw new ForbiddenException();
    return true;
  }
}
