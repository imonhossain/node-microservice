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

# Frontend: TanStack Router + form/zod helpers
npm install @tanstack/react-router zod react-hook-form @hookform/resolvers -w @syncra/frontend
```

---

## 2. Create `libs/auth-kit`

`libs/auth-kit/package.json` — same shape as db-kit on Day 2: composite build, conditional `exports`, and a `copy-assets` step for the Casbin `.conf` + `.csv` files (tsc doesn't copy non-TS files).

```json
{
  "name": "@syncra/auth-kit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "@org/source": "./src/index.ts",
      "types":       "./dist/index.d.ts",
      "default":     "./dist/index.js"
    }
  },
  "scripts": {
    "build":       "tsc && npm run copy-assets",
    "copy-assets": "mkdir -p dist/casbin && cp src/casbin/model.conf src/casbin/policy.csv dist/casbin/"
  },
  "dependencies": {
    "casbin": "^5.30.0"
  },
  "peerDependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core":   "^11.0.0"
  },
  "devDependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core":   "^11.0.0",
    "@types/express": "^5.0.0",
    "typescript":     "~5.6.0"
  }
}
```

`libs/auth-kit/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "lib": ["ES2022"],
    "target": "ES2022",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": false,
    "noUnusedLocals": false
  },
  "include": ["src/**/*"],
  "exclude": ["dist"]
}
```

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
m = g(r.sub, p.sub) && keyMatch(r.obj, p.obj) && keyMatch(r.act, p.act)
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

> The model + policy are inlined as string constants below, not loaded from disk. Reason: the backend bundles `auth-kit` into webpack's `main.js`, so the `casbin/*.conf` files no longer live next to `enforcer.js` at runtime (and `import.meta.dirname` breaks in the CJS bundle). Keeping the strings here means the enforcer works regardless of how it's deployed. The matching files in `src/casbin/` stay as the editable source of truth for tooling like Casbin's online editor.

```ts
import { Enforcer, Model, StringAdapter, newEnforcer, newModel } from 'casbin';

const MODEL = `
[request_definition]
r = sub, obj, act

[policy_definition]
p = sub, obj, act

[role_definition]
g = _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub) && keyMatch(r.obj, p.obj) && keyMatch(r.act, p.act)
`.trim();

const POLICY = `
p, owner,  workspace/*, *
p, admin,  workspace/*, workspace:read
p, admin,  workspace/*, workspace:rename
p, admin,  workspace/*, workspace:invite
p, admin,  workspace/*, member:list
p, admin,  workspace/*, member:remove
p, member, workspace/*, workspace:read
p, member, workspace/*, member:list
p, viewer, workspace/*, workspace:read
`.trim();

let enforcer: Enforcer | null = null;

export async function getEnforcer(): Promise<Enforcer> {
  if (enforcer) return enforcer;
  const model: Model = newModel(MODEL);
  const adapter = new StringAdapter(POLICY);
  enforcer = await newEnforcer(model, adapter);
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
import { REQUIRE_ACTION_KEY } from './require-action.decorator.js';
import { can } from './enforcer.js';

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
export * from './enforcer.js';
export * from './require-action.decorator.js';
export * from './action.guard.js';
```

Install + smoke test + build:

```sh
npm install
npm exec --workspace=@syncra/auth-kit -- tsc --noEmit   # typecheck
npm run build -w @syncra/auth-kit                       # emit dist/ + copy casbin assets
ls libs/auth-kit/dist/casbin/                            # model.conf, policy.csv
```

---

## 2.5 Backend webpack config — bundle workspace siblings + lock CJS

Before the backend can boot with `@syncra/auth-kit` as a dependency, two backend-app tweaks are needed. These are one-time fixes that pay off for every future lib we add.

### Mark the backend as CJS

Webpack with `target: 'node'` outputs CJS-style bundles, but Node 24 auto-flips a `.js` file to ESM if it sees `import`/`export` syntax (which bundled ESM libs contain). Pin it:

`apps/backend/package.json` — add the `type` field:

```json
{
  "name": "@syncra/backend",
  "type": "commonjs",
  ...
}
```

### Tell webpack to bundle `@syncra/*` into `main.js`

`apps/backend/webpack.config.js`:

```js
const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

/**
 * Wraps the externals NxAppWebpackPlugin installs and short-circuits any
 * `@syncra/*` import to "bundle" (so it ends up inside main.js).
 *
 * Why: default `target: 'node'` externalises every node_modules dep. At
 * runtime `@nx/js:node` rewrites the require to <repoRoot>/dist/libs/<name>
 * — a path that doesn't exist because our libs build into libs/<name>/dist.
 * Bundling workspace siblings sidesteps the runtime path mismatch entirely.
 */
class BundleSyncraLibsPlugin {
  apply(compiler) {
    compiler.hooks.afterEnvironment.tap('BundleSyncraLibsPlugin', () => {
      const original = compiler.options.externals;
      const wrap = (entry) => {
        if (typeof entry !== 'function') return entry;
        return function (ctx, callback) {
          if (ctx.request && ctx.request.startsWith('@syncra/')) {
            return callback();      // bundle
          }
          return entry(ctx, callback); // delegate to webpack-node-externals
        };
      };
      compiler.options.externals = Array.isArray(original)
        ? original.map(wrap)
        : wrap(original);
    });
  }
}

module.exports = {
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
    new BundleSyncraLibsPlugin(),
  ],
};
```

Verify the backend boots:

```sh
npx nx serve backend
curl -s -i http://localhost:3000/api/me | head -3   # → 401 Unauthorized (correct — no cookie)
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

> **Two connections, two purposes — get this right or weird bugs follow.**
>
> | Use | Connection | RLS? |
> | --- | --- | --- |
> | Per-tenant reads/writes inside a request handler (after we know which workspace) | `appDb` (`app_user`, NO BYPASSRLS) | Yes — `withCtx` sets `app.workspace_id` first |
> | **Discovery** queries that have to span tenants (slug → workspace, list workspaces for a user) | `db` (superuser, BYPASSRLS) | No — bypassed |
>
> Discovery queries can't set `app.workspace_id` because finding it is the whole point of the query. If you route those through `appDb`, RLS hides every row and the lookup silently returns `null` / `[]` — `isSlugAvailable` falsely reports "available", `findBySlug` 404s known workspaces, `listForUser` returns an empty list and the user is stuck in onboarding forever.

```ts
import { Injectable, NotFoundException, GoneException } from '@nestjs/common';
// IMPORTANT: import drizzle helpers (and, eq, gt, isNull, sql, …) THROUGH db-kit.
// Importing from 'drizzle-orm' directly triggers the dual-package hazard:
// backend is CJS, db-kit is ESM → two distinct SQL<unknown> types.
// (Set on Day 3 — same rule for every new service from here on.)
//
// `db`     = superuser, bypasses RLS. Use for cross-tenant discovery.
// `appDb`  = app_user, RLS enforced. Use for per-tenant work inside withCtx().
import { appDb, db, schema, and, eq, gt, isNull, sql } from '@syncra/db-kit';
import { randomUUID } from 'node:crypto';
import { MailService } from '../mail/mail.service';
import { generateRawToken, hashToken, verifyToken } from './invitation-token';

@Injectable()
export class WorkspaceService {
  constructor(private readonly mail: MailService) {}

  async isSlugAvailable(slug: string): Promise<boolean> {
    // Discovery — must see every tenant's workspaces. Without bypass-RLS the
    // result is always `true` (RLS hides existing rows) and the unique index
    // is the only thing catching collisions at insert time.
    const existing = await db.query.workspaces.findFirst({
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
    // Cross-tenant by design: a user belongs to many workspaces. We trust the
    // userId filter (verified session) and bypass RLS so the JOIN can span
    // every workspace_members row the user owns.
    return db
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
    // Discovery — the workspace_id we'd set for RLS is what we're trying to
    // find. Bypass RLS for the lookup; membership is asserted separately by
    // WorkspaceMiddleware before any per-tenant work happens.
    return db.query.workspaces.findFirst({ where: eq(schema.workspaces.slug, slug) });
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

We switch to **TanStack Router file-based routing** today. Routes live in `src/routes/`; a Vite plugin auto-generates `routeTree.gen.ts` from that tree on every save.

### 8.-1 Install the router plugin + devtools

```sh
npm install --save-dev @tanstack/router-plugin -w @syncra/frontend
npm install @tanstack/router-devtools -w @syncra/frontend
```

Wire it into `apps/frontend/vite.config.mts`:

```ts
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';

// inside defineConfig:
plugins: [
  // Generate src/routeTree.gen.ts from src/routes/. MUST run BEFORE react().
  TanStackRouterVite({ target: 'react', autoCodeSplitting: true }),
  react(),
],
```

The plugin watches `src/routes/` and writes `src/routeTree.gen.ts` whenever you add, rename, or delete a route file. The generated file is what `createRouter({ routeTree })` consumes.

### 8.-0.5 The router-level wiring (`__root.tsx` + `app.tsx`)

`apps/frontend/src/routes/__root.tsx` — the outermost layout. Carries the `QueryClient` in router context so `beforeLoad` guards can read it.

```tsx
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';

export interface RouterContext { queryClient: QueryClient }

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});
```

`apps/frontend/src/app/app.tsx` — replaces the Day 3 minimal shell:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { routeTree } from '../routeTree.gen';

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof buildRouter>;
  }
}

function buildRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
  });
}

export function App() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  }));
  const [router] = useState(() => buildRouter(queryClient));
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
```

### 8.-0.25 The two layout guards (this is where the auto-redirect lives)

`apps/frontend/src/routes/_app.tsx` — wraps everything that requires a workspace. **This is the guard that redirects to `/onboarding/workspace`** when the user has no memberships.

```tsx
import { Link, Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { WorkspaceSwitcher } from '../components/workspace-switcher';
import { useMe } from '../hooks/use-me';
import { useWorkspaces } from '../hooks/use-workspaces';

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    // 1) signed-in? → if not, send to /login
    const me = await context.queryClient.fetchQuery({
      queryKey: ['me'],
      queryFn: async () => {
        const r = await fetch('/api/me', { credentials: 'include' });
        if (r.status === 401) return null;
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      },
      staleTime: 30_000,
    });
    if (!me) throw redirect({ to: '/login' });

    // 2) has memberships? → if not, force onboarding
    const memberships = await context.queryClient.fetchQuery({
      queryKey: ['workspaces'],
      queryFn: async () => {
        const r = await fetch('/api/workspaces', { credentials: 'include' });
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      },
      staleTime: 30_000,
    });
    if (memberships.length === 0 && !location.pathname.startsWith('/onboarding')) {
      throw redirect({ to: '/onboarding/workspace' });
    }
  },
  component: AppShell,
});

function AppShell() {
  const { data: me } = useMe();
  const { data: workspaces } = useWorkspaces();
  const activeWs = workspaces?.[0];

  if (!me) return null;

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 24px', borderBottom: '1px solid #e5e7eb', background: 'white' }}>
        <Link to="/" style={{ fontWeight: 700, fontSize: 18, textDecoration: 'none', color: '#111' }}>
          Syncra
        </Link>
        <WorkspaceSwitcher />
        {activeWs && (
          <nav style={{ display: 'flex', gap: 16, marginLeft: 24 }}>
            <Link to="/w/$slug" params={{ slug: activeWs.slug }} style={{ color: '#444', textDecoration: 'none' }}>Overview</Link>
            <Link to="/w/$slug/members" params={{ slug: activeWs.slug }} style={{ color: '#444', textDecoration: 'none' }}>Members</Link>
          </nav>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {me.avatarUrl && <img src={me.avatarUrl} alt="" width={32} height={32} style={{ borderRadius: '50%' }} />}
          <div style={{ fontSize: 14 }}>
            <div style={{ fontWeight: 500 }}>{me.displayName ?? me.email}</div>
            <div style={{ color: '#666', fontSize: 12 }}>{me.email}</div>
          </div>
          <form method="post" action="/api/auth/signout">
            <button type="submit" style={{ padding: '6px 12px', background: 'white', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer' }}>
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main style={{ padding: 24 }}><Outlet /></main>
    </div>
  );
}
```

`apps/frontend/src/routes/onboarding.tsx` — wraps onboarding pages. Requires sign-in but **not** an existing workspace (otherwise the `/_app` guard would loop back here forever).

> ⚠️ **Note**: this folder is `onboarding/` **without** the underscore, because we want `/onboarding/workspace` and `/onboarding/invite` in the URL. A pathless `_onboarding/` would put children at `/workspace` and `/invite` — not what we want, and `/invite` would clash with the `invite/$token` route.

```tsx
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/onboarding')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery({
      queryKey: ['me'],
      queryFn: async () => {
        const r = await fetch('/api/me', { credentials: 'include' });
        if (r.status === 401) return null;
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      },
      staleTime: 30_000,
    });
    if (!me) throw redirect({ to: '/login' });
  },
  component: () => <div style={{ padding: 24 }}><Outlet /></div>,
});
```

`apps/frontend/src/routes/_auth.tsx` — for `/login`. Sends signed-in users to `/`.

```tsx
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_auth')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery({
      queryKey: ['me'],
      queryFn: async () => {
        const r = await fetch('/api/me', { credentials: 'include' });
        if (r.status === 401) return null;
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      },
      staleTime: 30_000,
    });
    if (me) throw redirect({ to: '/' });
  },
  component: () => <Outlet />,
});
```

> The `/login` page itself moves from `apps/frontend/src/app/login.tsx` into `apps/frontend/src/routes/_auth/login.tsx`, with `export const Route = createFileRoute('/_auth/login')({ component: LoginPage })` added at the top.

### 8.0 TanStack Router file naming — the prefixes you'll see

### 8.0 TanStack Router file naming — the prefixes you'll see

File-based routing means the **directory + filename** determines the URL. TanStack Router uses three special prefix conventions you'll see repeatedly in Syncra:

| Pattern             | What it means                                                                                                                                                | URL example                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **`_foo.tsx`** (leading underscore) | A **pathless layout route**. The `_` says "this is a layout wrapper; do NOT add `/foo` to the URL". Children of `_foo/` appear at the parent's URL. Use it for guards / layouts when you want the URL clean. | `_app.tsx` → no URL segment; child `_app/index.tsx` maps to `/`; `_app/w/$slug/members.tsx` maps to `/w/<slug>/members`. |
| **`foo.tsx` + `foo/` dir** (no underscore) | A layout route that DOES contribute a URL segment. Children appear under `/foo/...`. | `onboarding.tsx` + `onboarding/workspace.tsx` → `/onboarding/workspace`. |
| **`$foo.tsx`** (leading dollar)     | A **dynamic path parameter**. `$slug` matches any URL segment and exposes it as `params.slug` via `useParams()`. The `$` is the file-system-safe way to write what URL routing would call `:slug`. | `$token.tsx` matches `/foo`, `/r9-jK_3xMz`, etc.; inside the component: `const { token } = Route.useParams()`. |
| **`__root.tsx`** (double underscore) | The **outermost layout** — wraps every route in the app. Defines the shell `<Outlet />`, providers, error boundary. There's exactly one per app. | Always at `src/routes/__root.tsx`. |
| **`index.tsx`**                     | The **default child** of a directory. Maps to the directory's own path with no extra segment.                                                                | `onboarding/index.tsx` would map to `/onboarding`. `_app/w/$slug/index.tsx` maps to `/w/<slug>`.                       |

#### The trap I want you to remember

> If a directory or file starts with `_`, **the URL drops that segment**. If not, **the URL keeps it**.
>
> So `_onboarding/workspace.tsx` is `/workspace`, but `onboarding/workspace.tsx` is `/onboarding/workspace`. Naming this wrong is the most common cause of "Not Found" in dev.

#### Walk-through of the routes Day 4 uses

```
src/routes/
├── __root.tsx                          → wraps EVERY page (providers, layout shell)
├── _auth/
│   └── login.tsx                       → /login         (auth-only layout; guard: redirect to / if already signed in)
├── onboarding.tsx                      → wraps onboarding pages with a sign-in-required guard
├── onboarding/
│   ├── workspace.tsx                   → /onboarding/workspace
│   └── invite.tsx                      → /onboarding/invite
├── invite/
│   └── $token.tsx                      → /invite/r9-jK_3xMz...        (the token is the URL param)
└── _app/                               → no URL segment; guards live here (signed in? has membership?)
    ├── index.tsx                       → /
    └── w/
        └── $slug/                      → /w/acme         (slug = "acme")
            ├── index.tsx               → /w/acme         (workspace home)
            └── members.tsx             → /w/acme/members
```

The mental model:

- **Underscore = "I'm here for structure, not for URL"** — layouts, guards, grouping.
- **Dollar = "I'm a wildcard segment"** — bind to a value with `useParams`.
- **Combine them**: `_app/w/$slug/members.tsx` →
  - `_app` adds nothing to the URL but wraps children in the authenticated shell.
  - `w` adds `/w`.
  - `$slug` adds a dynamic segment.
  - `members` adds `/members`.
  - Final URL: `/w/<slug>/members`.

#### Why bother with the underscore layout pattern?

Without `_app`, every authenticated page would need its own `beforeLoad` guard checking session + workspace membership. With `_app`, you write it ONCE on the parent and every child inherits it. Same for `_auth` (redirect-if-signed-in) and `onboarding` (no membership required, but must be signed in).

#### The `from` argument in `useParams` / `useSearch`

You'll see things like:

```ts
const { token } = useParams({ from: '/invite/$token' });
const search = useSearch({ from: '/onboarding/invite' });
```

The `from` is the **route id** (which mirrors the file path). It tells TanStack Router which route's params/search you mean — important because route ids are typed, so `params.token` is `string`, not `string | undefined`. If you omit `from`, the types widen.

> **More on this in Day 6**, where we wire `__root.tsx`, the guard chain, and the full file-based router setup. Today we just write the route files; Day 6 plugs them into the router.

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

`apps/frontend/src/routes/onboarding/workspace.tsx`:

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

`apps/frontend/src/routes/onboarding/invite.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

export function OnboardingInvitePage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/onboarding/invite' }) as { slug: string };
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

1. Open `http://localhost:4200/login` → sign in with Google (user A).
2. Auto-redirect to `/onboarding/workspace`.
3. Name "Acme Inc.", slug auto-fills "acme-inc" → check ✓ available → **Create**.
4. Land on `/onboarding/invite` → enter `bob@example.com` → **Send invites**.
5. Open Mailpit at `http://localhost:8025` → click the invite email → copy the magic link.
6. Open an incognito window → paste the magic link → it sends you to `/login?next=/invite/<token>`.
7. Sign in as user B (different Google account) → automatically continues to invitation acceptance → lands on `/w/acme-inc`.
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
| `tsc --noEmit` on auth-kit: `Cannot find module './require-action.decorator'` or `Relative import paths need explicit file extensions` | NodeNext requires `.js` extensions on relative imports, even from `.ts` files | Every relative import inside `libs/auth-kit/src/*.ts` ends in `.js` (e.g. `from './enforcer.js'`)   |
| Casbin throws `ENOENT` for `model.conf` / `policy.csv` at runtime       | `tsc` doesn't copy non-TS assets to `dist/`                          | Add a `copy-assets` step to the build: `cp src/casbin/model.conf src/casbin/policy.csv dist/casbin/`  |
| `Type 'SQL<unknown>' is not assignable to type 'SQL<unknown>'` in `workspace.service.ts` (or any backend service) | Dual-package hazard — backend (CJS) loaded `drizzle-orm` separately from db-kit (ESM) | Import drizzle helpers THROUGH `@syncra/db-kit`: `import { appDb, schema, eq, and, sql } from '@syncra/db-kit'`. **Never `from 'drizzle-orm'` in app code.** (Rule set on Day 3.) |
| `new row violates row-level security policy for table "workspaces"`     | The `WITH CHECK` clause requires `app.workspace_id == new.id`; we set it AFTER inserting | Pre-generate the UUID and `set_config('app.workspace_id', newId, true)` BEFORE the INSERT          |
| Invitation accept returns "not found" even with a valid token           | Token expired, or already accepted                                    | Check `expires_at > now()` and `accepted_at IS NULL` in the candidate scan                          |
| Mailpit shows zero emails                                               | SMTP host/port wrong, or `nodemailer` can't reach `localhost:1025`    | `docker compose ps mailpit` → confirm port 1025; `SMTP_HOST=localhost SMTP_PORT=1025` in `.env`     |
| `ForbiddenException` on `workspace:invite` even as the owner            | Casbin policy missing for `owner`; or `req.membership.role` is undefined | `policy.csv` line 1: `p, owner, workspace/*, *`. Check `WorkspaceMiddleware` populates `req.membership`. |
| Frontend `/w/$slug` 404s after creation                                 | Workspace switcher cache stale; or the route file is missing          | `qc.invalidateQueries({ queryKey: ['workspaces'] })` after create; ensure `_app/w/$slug/index.tsx` exists |
| Argon2 install fails on `npm install argon2`                               | Native build needs `node-gyp`                                         | macOS: `xcode-select --install`. Or use `@node-rs/argon2` as a Rust drop-in.                        |
| Two workspaces with the same slug                                       | Race between two concurrent slug-availability checks + create         | Rely on the unique index on `workspaces.slug` — handle `23505` (unique violation) and 409 the client |
| Inviting same email twice fails                                         | Partial unique index from Day 2: one open invitation per email per ws  | Catch `23505`; return "invitation already pending"                                                  |
| Accept-invite endpoint mis-keys the user                                | Used `email` to match instead of token hash                            | Always match via `argon2.verify(row.tokenHash, rawToken)`                                            |
| Casbin policy not loading                                               | Wrong path to `model.conf` / `policy.csv` after build                  | Inline model + policy as string constants in `enforcer.ts`; load via `newModel(text)` + `new StringAdapter(text)`. Bundled libs lose disk paths. |
| Backend boot: `Cannot find module '/Users/.../dist/libs/auth-kit'`      | `target: 'node'` externalises every node_modules dep. At runtime Nx rewrites the require to `<repoRoot>/dist/libs/<name>`, but we emit to `libs/<name>/dist`. | In `apps/backend/webpack.config.js`: bundle `@syncra/*` workspace siblings into `main.js` instead of leaving them external. See the `BundleSyncraLibsPlugin` snippet. |
| Backend boot: `Reparsing as ES module because module syntax was detected` → `require is not defined in ES module scope` | Node 24 auto-flips `main.js` to ESM when it sees `import`/`export` syntax from bundled ESM libs. Backend's `package.json` has no `"type"` field. | Add `"type": "commonjs"` to `apps/backend/package.json` (NOT the root one — backend only). |
| Backend boot: `SyntaxError: Cannot use 'import.meta' outside a module`  | Bundled ESM lib code (e.g. `import.meta.dirname` in `enforcer.ts`) gets baked into a CJS bundle | Don't rely on `import.meta` inside libs that get bundled. For Casbin specifically, inline the model + policy strings instead of reading files at runtime. |
| Browser shows TanStack Router "Not Found" for `/onboarding/workspace`   | Directory is `_onboarding/` (underscore = pathless); children appear at `/workspace`, not `/onboarding/workspace` | Rename the directory + the layout file to `onboarding/` (no underscore). Update `createFileRoute('/onboarding/...')` and any `useSearch({ from: '/onboarding/...' })`. Restart Vite so the plugin regenerates `routeTree.gen.ts`. |
| `POST /api/workspaces/<slug>/invitations` → `{"statusCode":404,"message":"Workspace not found"}` even though the row exists, AND `/api/workspaces` returns `[]` even after creating workspaces | `WorkspaceService.findBySlug` / `listForUser` / `isSlugAvailable` were using `appDb` (RLS enforced). Without `app.workspace_id` set, RLS hides every row → discovery silently fails | Switch those three methods to use `db` (superuser, BYPASSRLS). They're cross-tenant discovery — we trust the userId filter or slug param, not RLS, for access control. |
| Slug-availability check incorrectly reports an existing slug as `available: true` | Same `appDb` RLS-hides-rows bug in `isSlugAvailable`. Two users (or the same user twice) end up with near-duplicate slugs because only the DB unique index catches the second one | Use `db` for `isSlugAvailable`; rely on the unique index as the second line of defense |
| `403 Forbidden` on `/api/workspaces/<slug>/members` even as the workspace **owner** | Casbin matcher used `r.act == p.act` (literal string equality), so the owner policy `p, owner, workspace/*, *` never matched (`'member:list' == '*'` is false). The `*` wildcard is silent — looks right, never fires. | Change the matcher to `keyMatch(r.act, p.act)` in both `libs/auth-kit/src/casbin/model.conf` AND the inline `MODEL` string in `enforcer.ts`. `keyMatch` treats `*` as a wildcard. Rebuild auth-kit and restart backend. |
| `tsc` errors `Cannot find name 'p'` / `';' expected` after editing the inline `MODEL` string in `enforcer.ts` | A backtick character inside the template literal closes it early. Casbin `#` comments often contain backticks (e.g. `` # `r.act == p.act` ``). | Keep explanatory text **outside** the template literal — put it as a regular `// …` comment above the `const MODEL = …` declaration. Inside the template, only valid Casbin syntax. |

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
