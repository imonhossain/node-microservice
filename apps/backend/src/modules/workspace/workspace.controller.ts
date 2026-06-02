import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ActionGuard, RequireAction } from '@syncra/auth-kit';
import { WorkspaceService } from './workspace.service';

@Controller('api')
@UseGuards(ActionGuard)
export class WorkspaceController {
  constructor(private readonly workspaces: WorkspaceService) {}

  @Get('workspaces/slug-available')
  async slugAvailable(@Query('slug') slug?: string) {
    if (!slug || !/^[a-z0-9-]{2,40}$/.test(slug)) {
      return { available: false, reason: 'invalid' };
    }
    return { available: await this.workspaces.isSlugAvailable(slug) };
  }

  @Get('workspaces')
  async list(@Req() req: Request) {
    if (!req.user) throw new UnauthorizedException();
    return this.workspaces.listForUser(req.user.id);
  }

  @Post('workspaces')
  async create(
    @Req() req: Request,
    @Body() body: { slug: string; name: string },
  ) {
    if (!req.user) throw new UnauthorizedException();
    if (!body.slug || !body.name)
      throw new BadRequestException('slug and name required');
    if (!(await this.workspaces.isSlugAvailable(body.slug))) {
      throw new BadRequestException('slug taken');
    }
    return this.workspaces.create({
      slug: body.slug,
      name: body.name,
      ownerId: req.user.id,
    });
  }

  @Post('workspaces/:slug/invitations')
  @RequireAction('workspace:invite')
  async invite(
    @Req() req: Request,
    @Param('slug') _slug: string,
    @Body() body: { email: string; role?: 'admin' | 'member' | 'viewer' },
  ) {
    if (!req.user || !req.workspace) throw new UnauthorizedException();
    return this.workspaces.invite({
      workspaceId: req.workspace.id,
      workspaceName: req.workspace.name,
      invitedBy: {
        id: req.user.id,
        displayName: req.user.displayName,
        email: req.user.email,
      },
      email: body.email,
      role: body.role ?? 'member',
    });
  }

  @Get('workspaces/:slug/members')
  @RequireAction('member:list')
  async members(@Req() req: Request) {
    if (!req.user || !req.workspace) throw new UnauthorizedException();
    return this.workspaces.listMembers(req.workspace.id, req.user.id);
  }

  @Post('invitations/accept')
  async accept(@Req() req: Request, @Body() body: { token: string }) {
    if (!req.user) throw new UnauthorizedException();
    if (!body.token) throw new BadRequestException('token required');
    return this.workspaces.accept({
      rawToken: body.token,
      userId: req.user.id,
    });
  }
}
