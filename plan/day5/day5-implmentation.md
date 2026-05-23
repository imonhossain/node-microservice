# Day 5 — Implementation

## 0. Pre-flight

```sh
nvm use 24
docker compose ps                                         # Day-1 infra Up
npx nx run backend:typecheck                             # Day 4 backend clean
npx nx run frontend:typecheck                            # Day 4 frontend clean
# Manual: sign in, /api/me works, /api/workspaces returns rows
```

---

## 1. Install dependencies

```sh
# Backend
npm install @trpc/server zod superjson -w @syncra/backend

# Contracts lib will need Zod + the @trpc/server type entry-point
npm install @trpc/server zod superjson -w @syncra/contracts

# Frontend
npm install @trpc/client @trpc/react-query @trpc/server superjson -w @syncra/frontend
# (@trpc/server is a peer of @trpc/react-query for type imports — required even on the client)
```

> `@trpc/server` is imported on the client *only for its types*. None of its runtime ships in the frontend bundle as long as you use type-only imports.

---

## 2. Wire `libs/contracts`

`libs/contracts/package.json` — confirm name + a `./server` subpath export:

```json
{
  "name": "@syncra/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".":         "./src/index.ts",
    "./server":  "./src/server.ts"
  }
}
```

> The `./server` subpath is the *type-only* surface the frontend imports. We keep it disjoint from runtime exports so a future runtime export doesn't accidentally bloat the SPA bundle.

`libs/contracts/src/workspace.schema.ts`:

```ts
import { z } from 'zod';

export const WorkspaceSlug = z.string().regex(/^[a-z0-9-]{2,40}$/);

export const CreateWorkspaceInput = z.object({
  slug: WorkspaceSlug,
  name: z.string().min(1).max(100),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInput>;

export const SlugAvailableInput = z.object({
  slug: WorkspaceSlug,
});

export const WorkspaceRole = z.enum(['admin', 'member', 'viewer']);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

export const InviteInput = z.object({
  slug: WorkspaceSlug,
  email: z.string().email(),
  role: WorkspaceRole.default('member'),
});
export type InviteInput = z.infer<typeof InviteInput>;

export const AcceptInviteInput = z.object({
  token: z.string().min(20),
});
export type AcceptInviteInput = z.infer<typeof AcceptInviteInput>;
```

`libs/contracts/src/index.ts`:

```ts
export * from './workspace.schema';
```

`libs/contracts/src/server.ts` — this is what the frontend imports for the router type. The actual router type lives in the backend; we re-export its type here.

```ts
// This file is imported by the frontend FOR TYPES ONLY.
// The runtime appRouter lives in apps/backend. We re-export its type alias.
export type { AppRouter } from '../../../apps/backend/src/trpc/router-types';
```

> Why a separate `router-types.ts` file in the backend? See §4. It isolates the `type AppRouter` re-export from anything that would pull runtime code into the type-graph (which is fine for types, but easier to reason about kept apart).

---

## 3. Backend — tRPC bootstrap

`apps/backend/src/trpc/context.ts`:

```ts
import type { Request, Response } from 'express';
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { WorkspaceService } from '../modules/workspace/workspace.service';
import { IdentityService } from '../modules/identity/identity.service';

export type Services = {
  workspaces: WorkspaceService;
  identity: IdentityService;
};

export type Context = {
  req: Request;
  res: Response;
  user?: Request['user'];
  services: Services;
};

export function createContextFactory(services: Services) {
  return function createContext(opts: CreateExpressContextOptions): Context {
    return {
      req: opts.req,
      res: opts.res,
      user: opts.req.user,        // hydrated by IdentityMiddleware (Day 3)
      services,
    };
  };
}
```

`apps/backend/src/trpc/trpc-init.ts`:

```ts
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import type { Context } from './context';
import { can } from '@syncra/auth-kit';

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

/** Requires a signed-in user. Adds `ctx.user` as non-nullable. */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/**
 * Builds a procedure that resolves `:slug` from the input, asserts membership,
 * and runs the Casbin check for the given action.
 *
 * Usage:
 *   workspaceProcedure('workspace:invite').input(z.object({ slug, ...})).mutation(...)
 */
export function workspaceProcedure(action: string) {
  return protectedProcedure.use(async ({ ctx, input, next }) => {
    const slug = (input as { slug?: string } | undefined)?.slug;
    if (!slug) throw new TRPCError({ code: 'BAD_REQUEST', message: 'slug required in input' });

    const ws = await ctx.services.workspaces.findBySlug(slug);
    if (!ws) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not found' });

    const membership = await ctx.services.workspaces.getMembership(ws.id, ctx.user.id);
    if (!membership) throw new TRPCError({ code: 'FORBIDDEN', message: 'not a member' });

    if (!(await can(membership.role, ws.slug, action))) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'insufficient permissions' });
    }

    return next({
      ctx: { ...ctx, workspace: { id: ws.id, slug: ws.slug, name: ws.name }, membership },
    });
  });
}
```

---

## 4. Backend — the routers

`apps/backend/src/trpc/routers/me.router.ts`:

```ts
import { router, protectedProcedure } from '../trpc-init';

export const meRouter = router({
  get: protectedProcedure.query(({ ctx }) => {
    const { id, email, displayName, avatarUrl, createdAt } = ctx.user;
    return { id, email, displayName, avatarUrl, createdAt };
  }),
});
```

`apps/backend/src/trpc/routers/workspace.router.ts`:

```ts
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  CreateWorkspaceInput,
  InviteInput,
  SlugAvailableInput,
  WorkspaceSlug,
} from '@syncra/contracts';
import { router, protectedProcedure, workspaceProcedure } from '../trpc-init';

export const workspaceRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    ctx.services.workspaces.listForUser(ctx.user.id),
  ),

  slugAvailable: protectedProcedure
    .input(SlugAvailableInput)
    .query(async ({ ctx, input }) => ({
      available: await ctx.services.workspaces.isSlugAvailable(input.slug),
    })),

  create: protectedProcedure
    .input(CreateWorkspaceInput)
    .mutation(async ({ ctx, input }) => {
      if (!(await ctx.services.workspaces.isSlugAvailable(input.slug))) {
        throw new TRPCError({ code: 'CONFLICT', message: 'slug taken' });
      }
      return ctx.services.workspaces.create({ ...input, ownerId: ctx.user.id });
    }),

  invite: workspaceProcedure('workspace:invite')
    .input(InviteInput)
    .mutation(({ ctx, input }) =>
      ctx.services.workspaces.invite({
        workspaceId: ctx.workspace.id,
        workspaceName: ctx.workspace.name,
        invitedBy: {
          id: ctx.user.id,
          displayName: ctx.user.displayName,
          email: ctx.user.email,
        },
        email: input.email,
        role: input.role,
      }),
    ),

  listMembers: workspaceProcedure('member:list')
    .input(z.object({ slug: WorkspaceSlug }))
    .query(({ ctx }) => ctx.services.workspaces.listMembers(ctx.workspace.id, ctx.user.id)),
});
```

`apps/backend/src/trpc/routers/invite.router.ts`:

```ts
import { AcceptInviteInput } from '@syncra/contracts';
import { router, protectedProcedure } from '../trpc-init';

export const inviteRouter = router({
  accept: protectedProcedure
    .input(AcceptInviteInput)
    .mutation(({ ctx, input }) =>
      ctx.services.workspaces.accept({ rawToken: input.token, userId: ctx.user.id }),
    ),
});
```

`apps/backend/src/trpc/router.ts`:

```ts
import { router } from './trpc-init';
import { meRouter } from './routers/me.router';
import { workspaceRouter } from './routers/workspace.router';
import { inviteRouter } from './routers/invite.router';

export const appRouter = router({
  me: meRouter,
  workspace: workspaceRouter,
  invite: inviteRouter,
});

export type AppRouter = typeof appRouter;
```

`apps/backend/src/trpc/router-types.ts` (this is what `libs/contracts/server` re-exports — keep it minimal):

```ts
export type { AppRouter } from './router';
```

---

## 5. Backend — mount on Express

`apps/backend/src/main.ts` (add the tRPC middleware before listen):

```ts
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { ExpressAuth } from '@auth/express';
import * as trpcExpress from '@trpc/server/adapters/express';

import { AppModule } from './app/app.module';
import { authConfig } from './auth/auth.config';
import { appRouter } from './trpc/router';
import { createContextFactory } from './trpc/context';
import { WorkspaceService } from './modules/workspace/workspace.service';
import { IdentityService } from './modules/identity/identity.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.use(cookieParser());
  app.use('/api/auth/*', ExpressAuth(authConfig));

  // Resolve service singletons from Nest, then build the tRPC context factory.
  const workspaces = app.get(WorkspaceService);
  const identity = app.get(IdentityService);
  const createContext = createContextFactory({ workspaces, identity });

  app.use(
    '/api/trpc',
    trpcExpress.createExpressMiddleware({ router: appRouter, createContext }),
  );

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`API running on http://localhost:${port}`);
}

bootstrap();
```

> Mount order: `cookieParser` → Auth.js → tRPC → Nest's catch-all. Earlier mounts win.

---

## 6. Frontend — tRPC client setup

`apps/frontend/src/lib/trpc.ts`:

```ts
import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@syncra/contracts/server';

export const trpc = createTRPCReact<AppRouter>();
```

`apps/frontend/src/lib/trpc-provider.tsx`:

```tsx
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from './trpc';

export function TrpcProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  }));

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: '/api/trpc',
          fetch(url, options) {
            return fetch(url, { ...options, credentials: 'include' });
          },
          transformer: superjson,
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
```

Wrap the app root — `apps/frontend/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import { TrpcProvider } from './lib/trpc-provider';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TrpcProvider>
      <App />
    </TrpcProvider>
  </StrictMode>,
);
```

> If you already have a `QueryClientProvider` from Day 3, **remove it** — `TrpcProvider` owns the QueryClient now. Two providers = two caches and weird invalidation.

---

## 7. Frontend — replace `fetch` with tRPC hooks

### 7.1 `useMe`

`apps/frontend/src/hooks/use-me.ts`:

```ts
import { trpc } from '../lib/trpc';

export function useMe() {
  // returns { data, isLoading, error } — fully typed
  return trpc.me.get.useQuery(undefined, { retry: false });
}
```

### 7.2 Workspace list, create, invite, members

`apps/frontend/src/hooks/use-workspaces.ts`:

```ts
import { trpc } from '../lib/trpc';

export function useWorkspaces() {
  return trpc.workspace.list.useQuery();
}

export function useCreateWorkspace() {
  const utils = trpc.useUtils();
  return trpc.workspace.create.useMutation({
    onSuccess: () => { utils.workspace.list.invalidate(); },
  });
}

export function useSlugAvailable(slug: string) {
  return trpc.workspace.slugAvailable.useQuery(
    { slug },
    { enabled: !!slug && /^[a-z0-9-]{2,40}$/.test(slug) },
  );
}

export function useInviteToWorkspace() {
  return trpc.workspace.invite.useMutation();
}

export function useMembers(slug: string) {
  return trpc.workspace.listMembers.useQuery({ slug }, { enabled: !!slug });
}

export function useAcceptInvitation() {
  const utils = trpc.useUtils();
  return trpc.invite.accept.useMutation({
    onSuccess: () => { utils.workspace.list.invalidate(); },
  });
}
```

### 7.3 Refactor yesterday's pages

In `routes/_onboarding/workspace.tsx` — replace fetch + state with hooks:

```tsx
import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSlugAvailable, useCreateWorkspace } from '../../hooks/use-workspaces';

export function OnboardingWorkspacePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const slugCheck = useSlugAvailable(slug);
  const create = useCreateWorkspace();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await create.mutateAsync({ slug, name });
    navigate({ to: '/onboarding/invite', search: { slug } });
  }

  return (
    <form onSubmit={submit}>
      <input value={name} onChange={(e) => setName(e.target.value)} required />
      <input value={slug} onChange={(e) => setSlug(e.target.value)} required pattern="[a-z0-9-]{2,40}" />
      {slugCheck.data?.available === false && <div>✗ taken</div>}
      <button disabled={!slugCheck.data?.available || create.isPending}>Create</button>
      {create.error && <div>Error: {create.error.message}</div>}
    </form>
  );
}
```

Apply the same pattern to `_onboarding/invite.tsx`, `invite/$token.tsx`, `_app/w/$slug/members.tsx`, and the workspace switcher.

> Delete the old REST fetch helpers from Day 4 once their callers are migrated.

---

## 8. Run and verify

```sh
npx nx serve backend
npx nx serve frontend
# Sign in, navigate the full Day-4 flow. Everything should still work, with no `fetch` calls in the components.
```

Type-safety smoke test:

```sh
# Open libs/contracts/src/workspace.schema.ts
# Change: `name: z.string().min(1).max(100)`
#    to:  `displayName: z.string().min(1).max(100)`
npx nx run frontend:typecheck
# → red errors in onboarding-workspace.tsx referencing `.name` field
# Revert the change.
```

Manual API sanity:

```sh
# Use a session cookie from the browser
COOKIE='__Host-syncra-session=<value>'

# query: me.get
curl -s "http://localhost:4200/api/trpc/me.get?batch=1&input=%7B%220%22%3A%7B%7D%7D" \
  -H "Cookie: $COOKIE" | head -c 300

# mutation: workspace.create (bad input → 400)
curl -i -s -X POST 'http://localhost:4200/api/trpc/workspace.create?batch=1' \
  -H "Cookie: $COOKIE" \
  -H 'content-type: application/json' \
  -d '{"0":{"json":{"slug":"BAD","name":""}}}' | head -10
# → 400, Zod error in body
```

---

## 9. ADR 0003

`docs/adr/0003-trpc-over-rest-for-web-edge.md`:

```markdown
---
status: accepted
date: 2026-05-13
deciders: imon
---

# 0003 — tRPC for the web SPA edge; REST for the public API

## Context and Problem Statement

The web SPA and the backend are one codebase. We want:

- Zero-drift types between server and client.
- Runtime input validation (defense against `curl`/malicious clients).
- Familiar TanStack Query semantics on the client.
- Zero codegen step in dev.

Third-party customers will also call us (Day 32+). They expect REST.

## Considered Options

- **tRPC** — TypeScript-only RPC; type-safe end-to-end; no codegen.
- **GraphQL** — Powerful, but heavy: schema, resolvers, codegen step, N+1 traps.
- **OpenAPI + codegen** — Standards-compliant, language-agnostic; introduces a codegen step and drift risk if not enforced.
- **Hand-written REST + shared Zod schemas** — Works; constant temptation to skip validation; types-at-the-edge still ad hoc.

## Decision Outcome

- **Web SPA edge → tRPC** (today).
- **Public API → REST `/v1/*`** (Day 32+).

tRPC gives us the best DX for first-party consumers. REST gives third parties the contract style they expect. The split is documented in ARCHITECTURE.md §4.1.

## Consequences

Good:
- Frontend refactors propagate as TypeScript errors, not runtime bugs.
- Zod schemas in `libs/contracts` are the single source of truth.
- Procedures compose: `workspaceProcedure(action).input(...).mutation(...)`.

Bad:
- TypeScript-only. A future non-TS internal client (Python, etc.) would need a thin REST/OpenAPI shim.
- tRPC routes (`/api/trpc/...`) are opaque to humans inspecting traffic — `curl` is more verbose.
- Two stacks (tRPC + REST) means two error-handling, two rate-limiting, two observability paths. We accept this; the public API surface is small.

## More Information

- ARCHITECTURE.md §4 — Communication patterns
- tRPC docs — https://trpc.io/docs
```

---

## 10. Done-criteria checklist

```sh
test -f apps/backend/src/trpc/router.ts
test -f apps/backend/src/trpc/router-types.ts
test -f libs/contracts/src/workspace.schema.ts
test -f apps/frontend/src/lib/trpc.ts
grep -q "createTRPCReact" apps/frontend/src/lib/trpc.ts
grep -q "@trpc/server/adapters/express" apps/backend/src/main.ts

npx nx run backend:typecheck
npx nx run frontend:typecheck

# No stray fetch('/api/workspaces...') calls left in components
! grep -r "fetch('/api/workspaces" apps/frontend/src 2>/dev/null && echo "✓ no REST calls left"

test -f docs/adr/0003-trpc-over-rest-for-web-edge.md
```

---

## 11. Common errors and fixes

| Symptom                                                                | Cause                                                                                       | Fix                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Frontend bundle balloons after wiring tRPC                              | Imported `AppRouter` via `import { type AppRouter }` (drops the `type` modifier)            | `import type { AppRouter } from '@syncra/contracts/server'`. Confirm with `rollup-plugin-visualizer` that no backend code is bundled |
| `TypeError: superjson is not a function`                                | Forgot transformer on either server or client                                               | Both `initTRPC.create({ transformer: superjson })` AND `httpBatchLink({ transformer: superjson })`                  |
| Date fields come back as strings                                        | superjson not configured on both sides                                                      | Same as above                                                                                                      |
| `UNAUTHORIZED` from every procedure even when signed in                 | Order in `main.ts` is wrong — tRPC mounted before IdentityMiddleware runs                   | IdentityMiddleware runs per Nest's pipeline. Make sure `req.user` is populated on the request that hits `/api/trpc` |
| Zod errors hidden as generic `INTERNAL_SERVER_ERROR`                    | Default error formatter doesn't include `zodError`                                          | Use the `errorFormatter` in `trpc-init.ts` shown above                                                              |
| `workspace.invite` runs without role check                              | `workspaceProcedure` was bypassed; you used `protectedProcedure` directly                   | Anywhere you act on a workspace, use `workspaceProcedure('verb')`, not `protectedProcedure`                          |
| `Property 'workspace' does not exist on type 'Context'`                 | Procedure isn't downstream of `workspaceProcedure`; or middleware chain returned wrong ctx  | Make sure `next({ ctx: { ...ctx, workspace, membership } })` runs                                                  |
| Two QueryClients in DevTools                                            | Day-3 `<QueryClientProvider>` not removed when adding `TrpcProvider`                        | Delete the old provider; `TrpcProvider` owns the QueryClient                                                       |
| `Cannot find module '@syncra/contracts/server'`                          | Subpath export missing from `libs/contracts/package.json`                                   | Confirm `"exports": { "./server": "./src/server.ts" }`                                                              |
| Frontend hangs on first tRPC call                                       | Vite proxy not forwarding `/api/trpc` (paths starting with `/api` should already be covered) | Confirm `vite.config.ts` proxies `/api`; tRPC lives under `/api/trpc`                                                |
| Big batch GET URL gets rejected (`URI Too Long`)                        | `httpBatchLink` batches many queries into one GET                                           | For huge batches, switch to `httpLink` (per-call) or split callers; rare in practice                                |

---

## 12. Tear down (debugging)

```sh
# Revert to per-call fetches by re-importing the old hooks. Generally not needed.
# To temporarily disable batching for easier debugging in DevTools:
#   replace httpBatchLink with httpLink in trpc-provider.tsx
```
