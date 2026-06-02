import {
  Injectable,
  NestMiddleware,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { WorkspaceService } from './workspace.service';

declare module 'express' {
  interface Request {
    workspace?: { id: string; slug: string; name: string };
    membership?: { role: 'owner' | 'admin' | 'member' | 'viewer' };
  }
}

@Injectable()
export class WorkspaceMiddleware implements NestMiddleware {
  constructor(private readonly workspaces: WorkspaceService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const slug = req.params['slug'] as string | undefined;
    if (!slug || !req.user) return next();

    const ws = await this.workspaces.findBySlug(slug);
    if (!ws) throw new NotFoundException('Workspace not found');

    const membership = await this.workspaces.getMembership(ws.id, req.user.id);
    if (!membership) throw new ForbiddenException('Not a member');

    req.workspace = { id: ws.id, slug: ws.slug, name: ws.name };
    req.membership = { role: membership.role };
    next();
  }
}
