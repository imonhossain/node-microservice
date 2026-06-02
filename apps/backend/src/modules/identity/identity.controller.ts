import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

@Controller('api')
export class IdentityController {
  @Get('me')
  me(@Req() req: Request) {
    if (!req.user) throw new UnauthorizedException();
    const { id, email, displayName, avatarUrl, createdAt } = req.user;
    return { id, email, displayName, avatarUrl, createdAt };
  }
}