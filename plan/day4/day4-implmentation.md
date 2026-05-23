# Day 4 — Implementation

## 0. Pre-flight

```sh
nvm use 24
docker compose ps                                                 # Day-1 infra Up
npm test -w @syncra/db-kit                                       # 3 passing
curl -s http://localhost:8025 | head -1                           # Mailpit UI OK
curl -s http://localhost:3000/api/me | head -1 || echo "backend up?"   # Day 3 wired
```

---

## 1. Install dependencies

```sh
# Backend: argon2 (token hashing), nodemailer (SMTP to Mailpit), casbin
npm install argon2 nodemailer casbin -w @syncra/backend
npm install --save-dev @types/nodemailer -w @syncra/backend

# auth-kit lib (shared Casbin helpers)
mkdir -p libs/auth-kit/src/casbin

# Frontend: TanStack Router (if not already) + form/zod helpers
npm install zod react-hook-form @hookform/resolvers -w @syncra/frontend
```

---

## 2. Create `libs/auth-kit`

`libs/auth-kit/package.json`:

```json
{
  "name": "@syncra/auth-kit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "casbin": "^5.30.0"
  },
  "devDependencies": {
    "typescript": "~5.6.0"
  }
}
```

`libs/auth-kit/tsconfig.json` — copy from `libs/db-kit/tsconfig.json` (same overrides: `types: ["node"]`, `composite: false`, etc.).

`libs/auth-kit/src/casbin/model.conf`:

```ini
[request_definition]
r = sub, obj, act

[policy_definition]
p = sub, obj, act

[role_definition]
g = _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub) && keyMatch(r.obj, p.obj) && r.act == p.act
```

`libs/auth-kit/src/casbin/policy.csv`:

```csv
p, owner,  workspace/*, *
p, admin,  workspace/*, workspace:read
p, admin,  workspace/*, workspace:rename
p, admin,  workspace/*, workspace:invite
p, admin,  workspace/*, member:list
p, admin,  workspace/*, member:remove
p, member, workspace/*, workspace:read
p, member, workspace/*, member:list
p, viewer, workspace/*, workspace:read
```

`libs/auth-kit/src/enforcer.ts`:

```ts
import { newEnforcer, Enforcer } from 'casbin';
import { join } from 'node:path';

let enforcer: Enforcer | null = null;

export async function getEnforcer(): Promise<Enforcer> {
  if (enforcer) return enforcer;
  const dir = join(import.meta.dirname, 'casbin');
  enforcer = await newEnforcer(join(dir, 'model.conf'), join(dir, 'policy.csv'));
  return enforcer;
}

export async function can(role: string, workspaceSlug: string, action: string): Promise<boolean> {
  const e = await getEnforcer();
  return e.enforce(role, `workspace/${workspaceSlug}`, action);
}
```

`libs/auth-kit/src/require-action.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';
export const REQUIRE_ACTION_KEY = 'syncra:requireAction';
export const RequireAction = (action: string) => SetMetadata(REQUIRE_ACTION_KEY, action);
```

`libs/auth-kit/src/action.guard.ts`:

```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { REQUIRE_ACTION_KEY } from './require-action.decorator';
import { can } from './enforcer';

@Injectable()
export class ActionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<string>(REQUIRE_ACTION_KEY, ctx.getHandler());
    if (!action) return true;

    const req = ctx.switchToHttp().getRequest<Request & { workspace?: { slug: string }; membership?: { role: string } }>();
    if (!req.workspace || !req.membership) throw new ForbiddenException();

    const allowed = await can(req.membership.role, req.workspace.slug, action);
    if (!allowed) throw new ForbiddenException();
    return true;
  }
}
```

`libs/auth-kit/src/index.ts`:

```ts
export * from './enforcer';
export * from './require-action.decorator';
export * from './action.guard';
```

Install + smoke test:

```sh
npm install
npm exec --workspace=@syncra/auth-kit -- tsc --noEmit
```

---

## 3. Backend — Mail service

`apps/backend/src/modules/mail/mail.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: false,
  });

  async sendInvite(opts: { to: string; inviter: string; workspaceName: string; acceptUrl: string }) {
    const info = await this.transport.sendMail({
      from: 'Syncra <noreply@syncra.dev>',
      to: opts.to,
      subject: `You've been invited to ${opts.workspaceName}`,
      text: `${opts.inviter} invited you to join "${opts.workspaceName}" on Syncra.\n\nAccept: ${opts.acceptUrl}\n\nThis link expires in 7 days.`,
      html: `<p>${opts.inviter} invited you to join <strong>${opts.workspaceName}</strong>.</p>
             <p><a href="${opts.acceptUrl}">Accept invitation</a></p>
             <p style="color:#888;font-size:12px">This link expires in 7 days.</p>`,
    });
    this.logger.log(`invite -> ${opts.to} (messageId ${info.messageId})`);
  }
}
```

`apps/backend/src/modules/mail/mail.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
```

`.env` — add the SMTP vars (Day 1's Mailpit is on 1025):

```sh
SMTP_HOST=localhost
SMTP_PORT=1025
APP_ORIGIN=http://localhost:4200
```

---

## 4. Backend — Workspace service

`apps/backend/src/modules/workspace/invitation-token.ts`:

```ts
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

export function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function hashToken(raw: string): Promise<string> {
  return argon2.hash(raw, { type: argon2.argon2id });
}

export async function verifyToken(hash: string, raw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, raw);
  } catch {
    return false;
  }
}
```

`apps/backend/src/modules/workspace/workspace.service.ts`:

```ts
import { Injectable, ConflictException, NotFoundException, GoneException } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { appDb, schema } from '@syncra/db-kit';
import { randomUUID } from 'node:crypto';
import { MailService } from '../mail/mail.service';
import { generateRawToken, hashToken, verifyToken } from './invitation-token';

@Injectable()
export class WorkspaceService {
  constructor(private readonly mail: MailService) {}

  async isSlugAvailable(slug: string): Promise<boolean> {
    const existing = await appDb.query.workspaces.findFirst({
      where: eq(schema.workspaces.slug, slug),
    });
    return !existing;
  }

  /**
   * Create workspace + owner membership atomically.
   * Sets app.workspace_id to the new id so the RLS WITH CHECK clause passes.
   */
  async create(args: { slug: string; name: string; ownerId: string }) {
    const newId = randomUUID();
    return appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id', ${newId}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_id',      ${args.ownerId}, true)`);

      const [ws] = await tx
        .insert(schema.workspaces)
        .values({ id: newId, slug: args.slug, name: args.name, ownerId: args.ownerId })
        .returning();

      await tx.insert(schema.workspaceMembers).values({
        workspaceId: ws.id,
        userId: args.ownerId,
        role: 'owner',
      });

      return ws;
    });
  }

  async listForUser(userId: string) {
    return appDb
      .select({
        id: schema.workspaces.id,
        slug: schema.workspaces.slug,
        name: schema.workspaces.name,
        role: schema.workspaceMembers.role,
      })
      .from(schema.workspaceMembers)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
      .where(eq(schema.workspaceMembers.userId, userId));
  }

  async findBySlug(slug: string) {
    return appDb.query.workspaces.findFirst({ where: eq(schema.workspaces.slug, slug) });
  }

  async getMembership(workspaceId: string, userId: string) {
    return appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_id',      ${userId}, true)`);
      return tx.query.workspaceMembers.findFirst({
        where: and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          eq(schema.workspaceMembers.userId, userId),
        ),
      });
    });
  }

  async listMembers(workspaceId: string, userId: string) {
    return appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_id',      ${userId}, true)`);
      return tx
        .select({
          userId: schema.workspaceMembers.userId,
          role: schema.workspaceMembers.role,
          joinedAt: schema.workspaceMembers.joinedAt,
          email: schema.users.email,
          displayName: schema.users.displayName,
          avatarUrl: schema.users.avatarUrl,
        })
        .from(schema.workspaceMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
        .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
    });
  }

  async invite(args: {
    workspaceId: string;
    workspaceName: string;
    invitedBy: { id: string; displayName: string | null; email: string };
    email: string;
    role: 'admin' | 'member' | 'viewer';
  }): Promise<{ acceptUrl: string }> {
    const raw = generateRawToken();
    const tokenHash = await hashToken(raw);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id', ${args.workspaceId}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_id',      ${args.invitedBy.id}, true)`);
      await tx.insert(schema.invitations).values({
        workspaceId: args.workspaceId,
        email: args.email,
        role: args.role,
        tokenHash,
        invitedBy: args.invitedBy.id,
        expiresAt,
      });
    });

    const acceptUrl = `${process.env.APP_ORIGIN}/invite/${raw}`;
    await this.mail.sendInvite({
      to: args.email,
      inviter: args.invitedBy.displayName ?? args.invitedBy.email,
      workspaceName: args.workspaceName,
      acceptUrl,
    });

    return { acceptUrl };
  }

  /**
   * Accept an invitation by raw token. We scan non-accepted, non-expired
   * invitations and argon2.verify each — fine at our scale.
   */
  async accept(args: { rawToken: string; userId: string }): Promise<{ workspaceSlug: string }> {
    const candidates = await appDb
      .select()
      .from(schema.invitations)
      .where(and(isNull(schema.invitations.acceptedAt), gt(schema.invitations.expiresAt, new Date())));

    let matched: typeof candidates[number] | null = null;
    for (const c of candidates) {
      if (await verifyToken(c.tokenHash, args.rawToken)) { matched = c; break; }
    }
    if (!matched) throw new NotFoundException('Invitation not found or expired');

    return appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id', ${matched.workspaceId}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_id',      ${args.userId}, true)`);

      // Check user isn't already a member (idempotent re-accept).
      const existing = await tx.query.workspaceMembers.findFirst({
        where: and(
          eq(schema.workspaceMembers.workspaceId, matched.workspaceId),
          eq(schema.workspaceMembers.userId, args.userId),
        ),
      });
      if (!existing) {
        await tx.insert(schema.workspaceMembers).values({
          workspaceId: matched.workspaceId,
          userId: args.userId,
          role: matched.role,
        });
      }

      await tx.update(schema.invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(schema.invitations.id, matched.id));

      const ws = await tx.query.workspaces.findFirst({
        where: eq(schema.workspaces.id, matched.workspaceId),
      });
      if (!ws) throw new GoneException('Workspace was deleted');
      return { workspaceSlug: ws.slug };
    });
  }
}
```

---

## 5. Backend — Workspace middleware

`apps/backend/src/modules/workspace/workspace.middleware.ts`:

```ts
import { Injectable, NestMiddleware, NotFoundException, ForbiddenException } from '@nestjs/common';
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
```

---

## 6. Backend — Workspace controller

`apps/backend/src/modules/workspace/workspace.controller.ts`:

```ts
import {
  BadRequestException, Body, Controller, Get, Param, Post, Query, Req,
  UnauthorizedException, UseGuards,
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
  async create(@Req() req: Request, @Body() body: { slug: string; name: string }) {
    if (!req.user) throw new UnauthorizedException();
    if (!body.slug || !body.name) throw new BadRequestException('slug and name required');
    if (!(await this.workspaces.isSlugAvailable(body.slug))) {
      throw new BadRequestException('slug taken');
    }
    return this.workspaces.create({ slug: body.slug, name: body.name, ownerId: req.user.id });
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
    return this.workspaces.accept({ rawToken: body.token, userId: req.user.id });
  }
}
```

---

## 7. Backend — Wire the module

`apps/backend/src/modules/workspace/workspace.module.ts`:

```ts
import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { WorkspaceMiddleware } from './workspace.middleware';

@Module({
  controllers: [WorkspaceController],
  providers: [WorkspaceService, WorkspaceMiddleware],
  exports: [WorkspaceService],
})
export class WorkspaceModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(WorkspaceMiddleware)
      .forRoutes(
        { path: 'api/workspaces/:slug/*', method: RequestMethod.ALL },
        { path: 'api/workspaces/:slug', method: RequestMethod.ALL },
      );
  }
}
```

`apps/backend/src/app/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module';
import { WorkspaceModule } from '../modules/workspace/workspace.module';
import { MailModule } from '../modules/mail/mail.module';

@Module({
  imports: [MailModule, IdentityModule, WorkspaceModule],
})
export class AppModule {}
```

---

## 8. Frontend — Onboarding routes

> If you're using TanStack Router file-based routes, paths are `src/routes/...`. If not, adapt to your router. The hooks below are framework-agnostic.

`apps/frontend/src/hooks/use-workspaces.ts`:

```ts
import { useQuery } from '@tanstack/react-query';

export type Workspace = { id: string; slug: string; name: string; role: 'owner' | 'admin' | 'member' | 'viewer' };

export function useWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: async (): Promise<Workspace[]> => {
      const res = await fetch('/api/workspaces', { credentials: 'include' });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });
}
```

`apps/frontend/src/routes/_onboarding/workspace.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';

export function OnboardingWorkspacePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  // Auto-fill slug from name
  useEffect(() => {
    if (!slug || slug === slugify(name.slice(0, -1))) setSlug(slugify(name));
  }, [name]);

  // Debounced slug availability
  useEffect(() => {
    if (!slug) { setAvailable(null); return; }
    const handle = setTimeout(async () => {
      const r = await fetch(`/api/workspaces/slug-available?slug=${slug}`);
      const j = await r.json();
      setAvailable(j.available);
    }, 300);
    return () => clearTimeout(handle);
  }, [slug]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, slug }),
    });
    setBusy(false);
    if (res.ok) {
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      navigate({ to: '/onboarding/invite', search: { slug } });
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 480, margin: '120px auto' }}>
      <h1>Create your workspace</h1>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>URL slug<input value={slug} onChange={(e) => setSlug(slugify(e.target.value))} required pattern="[a-z0-9-]{2,40}" /></label>
      <div>
        {available === null ? null : available ? '✓ available' : '✗ taken'}
      </div>
      <button disabled={!name || !slug || available !== true || busy}>Create</button>
    </form>
  );
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
```

`apps/frontend/src/routes/_onboarding/invite.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

export function OnboardingInvitePage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/_onboarding/invite' }) as { slug: string };
  const [emails, setEmails] = useState<string[]>(['']);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    for (const email of emails.filter(Boolean)) {
      await fetch(`/api/workspaces/${search.slug}/invitations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, role: 'member' }),
      });
    }
    setBusy(false);
    navigate({ to: '/w/$slug', params: { slug: search.slug } });
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 480, margin: '120px auto' }}>
      <h1>Invite your team</h1>
      <p>Optional — you can add people later.</p>
      {emails.map((email, i) => (
        <input
          key={i}
          type="email"
          placeholder="teammate@example.com"
          value={email}
          onChange={(e) => setEmails(emails.map((x, j) => (j === i ? e.target.value : x)))}
        />
      ))}
      <button type="button" onClick={() => setEmails([...emails, ''])}>+ Add another</button>
      <button disabled={busy}>Send invites</button>
      <button type="button" onClick={() => navigate({ to: '/w/$slug', params: { slug: search.slug } })}>
        Skip for now
      </button>
    </form>
  );
}
```

`apps/frontend/src/routes/invite/$token.tsx`:

```tsx
import { useEffect } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useMe } from '../../hooks/use-me';

export function AcceptInvitePage() {
  const navigate = useNavigate();
  const { token } = useParams({ from: '/invite/$token' });
  const { data: me, isLoading } = useMe();

  useEffect(() => {
    if (isLoading) return;
    if (!me) {
      // Not signed in: redirect to /login?next=/invite/<token>
      window.location.href = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
      return;
    }
    (async () => {
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        const { workspaceSlug } = await res.json();
        navigate({ to: '/w/$slug', params: { slug: workspaceSlug } });
      } else {
        navigate({ to: '/' });
      }
    })();
  }, [me, isLoading, token, navigate]);

  return <div style={{ padding: 80, textAlign: 'center' }}>Accepting invitation…</div>;
}
```

---

## 9. Frontend — Members list + workspace switcher

`apps/frontend/src/routes/_app/w/$slug/members.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';

export function MembersPage() {
  const { slug } = useParams({ from: '/_app/w/$slug/members' });
  const { data } = useQuery({
    queryKey: ['members', slug],
    queryFn: async () => {
      const res = await fetch(`/api/workspaces/${slug}/members`, { credentials: 'include' });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json() as Promise<Array<{ userId: string; role: string; email: string; displayName: string | null; avatarUrl: string | null; joinedAt: string }>>;
    },
  });
  return (
    <div>
      <h1>Members</h1>
      <ul>
        {data?.map((m) => (
          <li key={m.userId}>
            {m.displayName ?? m.email} — <em>{m.role}</em>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

`apps/frontend/src/components/workspace-switcher.tsx`:

```tsx
import { useNavigate, useParams } from '@tanstack/react-router';
import { useWorkspaces } from '../hooks/use-workspaces';

export function WorkspaceSwitcher() {
  const navigate = useNavigate();
  const { slug } = useParams({ strict: false });
  const { data: workspaces } = useWorkspaces();
  if (!workspaces?.length) return null;
  return (
    <select
      value={slug ?? ''}
      onChange={(e) => navigate({ to: '/w/$slug', params: { slug: e.target.value } })}
    >
      {workspaces.map((w) => <option key={w.id} value={w.slug}>{w.name}</option>)}
    </select>
  );
}
```

---

## 10. Run + manual demo

```sh
# Terminals (3 of them)
docker compose up -d           # if anything stopped
npx nx serve backend
npx nx serve frontend
```

Browser flow:

1. Open `http://localhost:4200/login` → sign in with GitHub (user A).
2. Auto-redirect to `/onboarding/workspace`.
3. Name "Acme Inc.", slug auto-fills "acme-inc" → check ✓ available → **Create**.
4. Land on `/onboarding/invite` → enter `bob@example.com` → **Send invites**.
5. Open Mailpit at `http://localhost:8025` → click the invite email → copy the magic link.
6. Open an incognito window → paste the magic link → it sends you to `/login?next=/invite/<token>`.
7. Sign in as user B (different GitHub account) → automatically continues to invitation acceptance → lands on `/w/acme-inc`.
8. Open `/w/acme-inc/members` — you see two rows.

---

## 11. Verify (paste-able)

```sh
# Tables populated
psql 'postgresql://syncra:syncra@localhost:6432/syncra' <<SQL
SELECT slug, name FROM workspaces;
SELECT w.slug, u.email, m.role
  FROM workspace_members m
  JOIN workspaces w ON w.id = m.workspace_id
  JOIN users u ON u.id = m.user_id
  ORDER BY w.slug, m.role;
SELECT email, accepted_at IS NOT NULL AS accepted, expires_at FROM invitations;
SQL

# Casbin sanity (run the enforcer manually)
npm exec --workspace=@syncra/auth-kit -- node -e "
  import('./src/enforcer.ts').then(async ({ can }) => {
    console.log('owner  / workspace:invite:', await can('owner',  'acme-inc', 'workspace:invite'));  // true
    console.log('member / workspace:invite:', await can('member', 'acme-inc', 'workspace:invite'));  // false
    console.log('viewer / workspace:read  :', await can('viewer', 'acme-inc', 'workspace:read'));    // true
  })
"

# Slug-availability endpoint
curl -s 'http://localhost:4200/api/workspaces/slug-available?slug=acme-inc' \
  | grep -q '"available":false' && echo OK

# Member-list endpoint requires membership (403 for non-members)
curl -i -s 'http://localhost:4200/api/workspaces/acme-inc/members' \
  -H "Cookie: __Host-syncra-session=<other-user-cookie>" | head -1
# HTTP/1.1 403 Forbidden
```

---

## 12. Done-criteria checklist

```sh
test -d libs/auth-kit                                                                  # auth-kit lib
test -f libs/auth-kit/src/casbin/policy.csv                                            # policy in place
test -f apps/backend/src/modules/workspace/workspace.service.ts                        # backend module
test -f apps/backend/src/modules/mail/mail.service.ts                                  # mail module
grep -q "RequireAction" apps/backend/src/modules/workspace/workspace.controller.ts     # guard decorator used

npx nx run backend:typecheck
npx nx run frontend:typecheck
# Manual: full sign-up → workspace → invite → accept flow works
```

---

## 13. Common errors and fixes

| Symptom                                                                | Cause                                                                | Fix                                                                                                  |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Cannot find module '@syncra/auth-kit'`                                 | Lib not in workspace yet                                              | Confirm root `package.json` `workspaces` includes `"libs/*"`; `npm install` from root              |
| `new row violates row-level security policy for table "workspaces"`     | The `WITH CHECK` clause requires `app.workspace_id == new.id`; we set it AFTER inserting | Pre-generate the UUID and `set_config('app.workspace_id', newId, true)` BEFORE the INSERT          |
| Invitation accept returns "not found" even with a valid token           | Token expired, or already accepted                                    | Check `expires_at > now()` and `accepted_at IS NULL` in the candidate scan                          |
| Mailpit shows zero emails                                               | SMTP host/port wrong, or `nodemailer` can't reach `localhost:1025`    | `docker compose ps mailpit` → confirm port 1025; `SMTP_HOST=localhost SMTP_PORT=1025` in `.env`     |
| `ForbiddenException` on `workspace:invite` even as the owner            | Casbin policy missing for `owner`; or `req.membership.role` is undefined | `policy.csv` line 1: `p, owner, workspace/*, *`. Check `WorkspaceMiddleware` populates `req.membership`. |
| Frontend `/w/$slug` 404s after creation                                 | Workspace switcher cache stale; or the route file is missing          | `qc.invalidateQueries({ queryKey: ['workspaces'] })` after create; ensure `_app/w/$slug/index.tsx` exists |
| Argon2 install fails on `npm install argon2`                               | Native build needs `node-gyp`                                         | macOS: `xcode-select --install`. Or use `@node-rs/argon2` as a Rust drop-in.                        |
| Two workspaces with the same slug                                       | Race between two concurrent slug-availability checks + create         | Rely on the unique index on `workspaces.slug` — handle `23505` (unique violation) and 409 the client |
| Inviting same email twice fails                                         | Partial unique index from Day 2: one open invitation per email per ws  | Catch `23505`; return "invitation already pending"                                                  |
| Accept-invite endpoint mis-keys the user                                | Used `email` to match instead of token hash                            | Always match via `argon2.verify(row.tokenHash, rawToken)`                                            |
| Casbin policy not loading                                               | Wrong path to `model.conf` / `policy.csv` after build                  | Use `import.meta.dirname` (Node 22+); ensure files are emitted next to `enforcer.js`                |

---

## 14. Tear down (debugging)

```sh
psql 'postgresql://syncra:syncra@localhost:6432/syncra' <<SQL
DELETE FROM workspace_members;
DELETE FROM invitations;
DELETE FROM workspaces;
DELETE FROM users;
SQL
# Sign in again; the flow starts fresh.
```
