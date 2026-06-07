# Day 5 — Implementation

> Stack: tRPC v11 + Zod + superjson + Express adapter on the backend, `@trpc/react-query` on the frontend. Reuses `@syncra/db-kit` + `@syncra/auth-kit` from earlier days.

## 0. Pre-flight (5 minutes)

```sh
nvm use 24
docker compose ps                                                # Day-1 infra still Up
npx nx run backend:typecheck                                     # clean
npx nx run frontend:typecheck                                    # clean
# In a browser: log in, hit /api/me, /api/workspaces → both return 200
```

If any of those are red, fix that first. Today builds on top of working Day-4.

---

## 1. Install dependencies

```sh
# Backend — tRPC server + superjson (handles Date/Map/Set over JSON)
npm install @trpc/server zod superjson -w @syncra/backend

# Contracts lib — same packages, because libs/contracts re-exports
# the AppRouter TYPE and the Zod schemas. We need them at typecheck time.
npm install @trpc/server zod superjson -w @syncra/contracts

# Frontend — tRPC client + React-Query adapter. @trpc/server is needed
# for *types only*; none of its runtime ships in the SPA bundle.
npm install @trpc/client @trpc/react-query @trpc/server superjson -w @syncra/frontend
```

> Why `@trpc/server` on the frontend? `@trpc/react-query` re-exports type helpers from `@trpc/server`. Without it your editor reports "Cannot find module". TypeScript only — none of its runtime is imported.

Verify:

```sh
grep -E '@trpc/(server|client|react-query)' apps/backend/package.json apps/frontend/package.json libs/contracts/package.json
```

---

## 2. Wire `libs/contracts` — the shared edge

This is the most important file structure of the day. Get it right and types flow end-to-end. Get it wrong and you'll fight TypeScript for an hour.

### 2.1 `libs/contracts/package.json` — two exports

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

> **Why two subpaths?** The `.` export gives the SPA access to the **Zod schemas** (used for validation + types). The `./server` export gives the SPA access to the **`AppRouter` type**. They're disjoint on purpose — if we later add server-only utilities, they go behind `./server` so the SPA bundle stays small.

### 2.2 The Zod schemas (one file per domain)

`libs/contracts/src/workspace.schema.ts`:

```ts
import { z } from 'zod';

export const WorkspaceSlug = z.string().regex(/^[a-z0-9-]{2,40}$/);

export const CreateWorkspaceInput = z.object({
  slug: WorkspaceSlug,
  name: z.string().min(1).max(100),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInput>;

export const SlugAvailableInput = z.object({ slug: WorkspaceSlug });

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

> **Pattern**: define the Zod schema, export it, then `export type Foo = z.infer<typeof Foo>` so the same identifier works as both schema and type. Saves a "what was that type called again" lookup.

### 2.3 Barrel files

`libs/contracts/src/index.ts`:

```ts
export * from './workspace.schema';
```

`libs/contracts/src/server.ts` — type-only re-export from the backend:

```ts
// IMPORTANT: this file is imported by the frontend FOR TYPES ONLY.
// The runtime appRouter lives in apps/backend. We re-export its type alias.
export type { AppRouter } from '../../../apps/backend/src/trpc/router-types';
```

> Why a separate `router-types.ts` in the backend (which we write below) and not re-export from `router.ts` directly? Isolating the type-only file means any future runtime code that might live next to `router.ts` (loggers, side-effect imports) can't accidentally end up bundled into the SPA via a deep type import.

---

## 3. Backend — tRPC bootstrap

Three files set up the core: per-request context, shared procedure helpers, and the router barrel.

### 3.1 The context — what every procedure can see

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
  user?: Request['user'];          // hydrated by IdentityMiddleware (Day 3)
  services: Services;
};

export function createContextFactory(services: Services) {
  return function createContext(opts: CreateExpressContextOptions): Context {
    return {
      req: opts.req,
      res: opts.res,
      user: opts.req.user,
      services,
    };
  };
}
```

> `user` is optional in the *base* context. The `protectedProcedure` helper below upgrades it to non-nullable. That way every procedure sees the right shape.

### 3.2 The procedure helpers — auth chain by composition

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

/** Requires a signed-in user. Adds non-nullable `ctx.user`. */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/**
 * workspaceProcedure(action):
 *   - reads input.slug → finds workspace
 *   - asserts membership
 *   - runs Casbin enforce(role, slug, action) → 403 if denied
 *   - adds ctx.workspace and ctx.membership for the handler to use
 *
 * Usage:
 *   workspaceProcedure('workspace:invite').input(...).mutation(({ ctx, input }) => ...)
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

Three things to notice:

1. **superjson** is set as the transformer here. We MUST set it on the client too — they have to match.
2. The `errorFormatter` adds `zodError` to the shape so the frontend can render field-level validation errors.
3. `workspaceProcedure` chains off `protectedProcedure` — so every workspace-scoped procedure automatically requires sign-in AND membership AND a Casbin check. That's a lot of safety written once.

---

## 4. Backend — the routers (one file per domain)

### 4.1 `me`

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

### 4.2 `workspace`

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

### 4.3 `invite`

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

### 4.4 The root router + type-only re-export

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

`apps/backend/src/main.ts` (add the tRPC middleware between `/api/auth` and `app.listen`):

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
  app.use('/api/auth', ExpressAuth(authConfig));

  // Pull service singletons out of Nest's DI container, then build the
  // tRPC context factory. The factory runs per-request inside the adapter.
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

> **Mount order matters**: `cookieParser` → Auth.js → tRPC → Nest's catch-all. Earlier mounts win. tRPC needs the cookie parsed before its context factory reads `req.user`.

---

## 6. Frontend — tRPC client setup

### 6.1 The client stub

`apps/frontend/src/lib/trpc.ts`:

```ts
import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@syncra/contracts/server';

// `import type` keeps the runtime bundle clean. Only the *shape* of AppRouter
// crosses the network boundary at compile time.
export const trpc = createTRPCReact<AppRouter>();
```

### 6.2 The provider

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
            // credentials: 'include' makes the session cookie travel with each call
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

### 6.3 Wire it into the app

`apps/frontend/src/app/app.tsx`:

```tsx
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { routeTree } from '../routeTree.gen';
import { TrpcProvider } from '../lib/trpc-provider';
import { QueryClient } from '@tanstack/react-query';

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
  return (
    <TrpcProvider>
      {/* If you wired a router previously, replace the previous QueryClient
          setup so TrpcProvider owns the singleton QueryClient. */}
      <InnerApp />
    </TrpcProvider>
  );
}

function InnerApp() {
  // Pull the QueryClient out of the tRPC provider so it can flow into the router.
  // Most projects just create a single QueryClient at app startup and pass it
  // to both. We keep this two-step shape so it's clear what depends on what.
  // (You can simplify if you prefer.)
  const [router] = useState(() => buildRouter(new QueryClient()));
  return <RouterProvider router={router} />;
}
```

> **Important**: if your Day-3 `app.tsx` already had a `<QueryClientProvider>`, **delete it**. Two providers in the tree = two caches = invalidation works in one and not the other. The new `TrpcProvider` owns the one true `QueryClient`.

---

## 7. Frontend — migrate Day-4 fetches to tRPC hooks

We replace every `fetch('/api/...')` call from Day 4 with a tRPC hook.

### 7.1 `useMe`

`apps/frontend/src/hooks/use-me.ts`:

```ts
import { trpc } from '../lib/trpc';

export function useMe() {
  return trpc.me.get.useQuery(undefined, { retry: false });
}
```

### 7.2 Workspaces

`apps/frontend/src/hooks/use-workspaces.ts`:

```ts
import { trpc } from '../lib/trpc';

export function useWorkspaces() {
  return trpc.workspace.list.useQuery();
}

export function useCreateWorkspace() {
  const utils = trpc.useUtils();
  return trpc.workspace.create.useMutation({
    onSuccess: () => utils.workspace.list.invalidate(),
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
    onSuccess: () => utils.workspace.list.invalidate(),
  });
}
```

### 7.3 Refactor the onboarding pages

Open `routes/onboarding/workspace.tsx`. Replace `fetch('/api/workspaces/...')` with the hooks above. Sketch:

```tsx
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSlugAvailable, useCreateWorkspace } from '../../hooks/use-workspaces';

function OnboardingWorkspacePage() {
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

Apply the same pattern to:
- `routes/onboarding/invite.tsx` — replace `fetch('/api/workspaces/.../invitations')` with `useInviteToWorkspace`.
- `routes/invite/$token.tsx` — `useAcceptInvitation`.
- `routes/_app/w/$slug/members.tsx` — `useMembers(slug)`.
- `routes/_app/index.tsx` — `useWorkspaces()`.
- `components/workspace-switcher.tsx` — already uses `useWorkspaces`; no change once that hook is the tRPC version.

Then **delete the raw fetch helpers** that the previous hooks used. They're dead code now.

---

## 8. Run + manual sanity check

```sh
# Terminal A
npm run backend
# Wait for "API running on http://localhost:3000"

# Terminal B
npm run frontend
# Wait for "Local: http://localhost:4200/"
```

In a browser, sign in. Walk the Day-4 flow: create workspace → invite teammates → land on workspace home → view members. **Everything should still work**, just now powered by tRPC calls instead of `fetch`. Pop open DevTools → Network. You'll see `/api/trpc/workspace.list?batch=1`, `/api/trpc/workspace.create?batch=1`, etc.

---

## 9. The type-safety smoke test (the whole point of today)

This is the proof that the contracts are tight:

```sh
# Step 1: edit libs/contracts/src/workspace.schema.ts
# Change `name: z.string().min(1).max(100)` → `displayName: z.string().min(1).max(100)`
# Save.

npx nx run frontend:typecheck
# → Expect: red errors on every line in the SPA that reads `.name`,
#   e.g. routes/_app/index.tsx, routes/_app/w/$slug/index.tsx, components/workspace-switcher.tsx

# Step 2: REVERT the schema change.
npx nx run frontend:typecheck
# → exit 0
```

Try the same with a Zod validation tweak (e.g., shorten `name`'s max to `10`). Frontend submissions of long names get rejected with a Zod error pre-render. Beautiful.

---

## 10. Verify (paste-able)

Get your session cookie value from the browser DevTools → Application → Cookies, then:

```sh
COOKIE='authjs.session-token=PASTE_VALUE_HERE'

# query: me.get
curl -s "http://localhost:4200/api/trpc/me.get?batch=1&input=%7B%220%22%3A%7B%7D%7D" \
  -H "Cookie: $COOKIE" | head -c 400; echo

# mutation: workspace.create with bad input (expect 400 with Zod error)
curl -i -s -X POST 'http://localhost:4200/api/trpc/workspace.create?batch=1' \
  -H "Cookie: $COOKIE" \
  -H 'content-type: application/json' \
  -d '{"0":{"json":{"slug":"BAD SLUG","name":""}}}' | head -10
```

You should see:
- `me.get` → 200 with your user JSON.
- `workspace.create` with bad input → 400, body contains the Zod validation error.

---

## 11. ADR 0003

`docs/adr/0003-trpc-over-rest-for-web-edge.md`:

```markdown
---
status: accepted
date: <today>
deciders: imon
---

# 0003 — tRPC for the web SPA edge; REST for the public API

## Context and Problem Statement

The web SPA and the backend are one codebase. We want:

- Zero-drift types between server and client.
- Runtime input validation (defense against `curl` and malicious clients).
- Familiar TanStack Query semantics on the client.
- Zero codegen step in the dev loop.

Third-party customers will also call us (Day 32+). They expect REST.

## Considered Options

- **tRPC** — TypeScript-only RPC; type-safe end-to-end; no codegen.
- **GraphQL** — Powerful, but heavier: schema, resolvers, codegen, N+1 traps.
- **OpenAPI + codegen** — Standards-compliant, language-agnostic; adds a codegen step and a drift risk if the team forgets to re-run it.
- **Hand-written REST + shared Zod schemas** — Works; constant temptation to skip validation; types-at-the-edge stay ad hoc.

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
- TypeScript-only. A future non-TS internal client (Python, etc.) needs a thin REST/OpenAPI shim.
- tRPC routes (`/api/trpc/...`) are opaque to humans inspecting traffic — `curl` is more verbose.
- Two stacks (tRPC + REST) mean two error-handling, two rate-limiting, two observability paths. We accept this; the public API surface is small and well-isolated.

## More Information

- ARCHITECTURE.md §4 — Communication patterns
- tRPC docs — https://trpc.io/docs
```

---

## 12. Done-criteria checklist

```sh
test -f apps/backend/src/trpc/router.ts
test -f apps/backend/src/trpc/router-types.ts
test -f libs/contracts/src/workspace.schema.ts
test -f libs/contracts/src/server.ts
test -f apps/frontend/src/lib/trpc.ts
test -f apps/frontend/src/lib/trpc-provider.tsx

grep -q "createTRPCReact" apps/frontend/src/lib/trpc.ts
grep -q "trpcExpress" apps/backend/src/main.ts

npx nx run backend:typecheck
npx nx run frontend:typecheck

# No stray fetch('/api/workspaces...') calls left in components.
# (The bare onboarding fetches were the migration target; route files now use hooks.)
! grep -r "fetch('/api/workspaces" apps/frontend/src 2>/dev/null && echo "✓ no REST workspace calls left"

test -f docs/adr/0003-trpc-over-rest-for-web-edge.md
```

---

## 13. Common errors and fixes

| Symptom                                                                | Cause                                                                                       | Fix                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Frontend bundle balloons after wiring tRPC                              | `import { type AppRouter } …` dropped the `type` modifier (or you imported from the backend directly) | `import type { AppRouter } from '@syncra/contracts/server'`. Confirm with `rollup-plugin-visualizer` that no backend code is in the bundle. |
| Dates come back as strings                                              | superjson configured on only one side                                                       | Both `initTRPC.create({ transformer: superjson })` AND `httpBatchLink({ transformer: superjson })`. They MUST match. |
| `UNAUTHORIZED` from every procedure even when signed in                 | tRPC mounted before `IdentityMiddleware` runs                                                | IdentityMiddleware runs per Nest's pipeline. Confirm `req.user` is populated on the request that hits `/api/trpc`. |
| Zod errors hidden as generic `INTERNAL_SERVER_ERROR`                    | Default error formatter doesn't include `zodError`                                          | Use the `errorFormatter` in `trpc-init.ts` shown above; check `error.data.zodError` on the client.                  |
| `workspace.invite` runs without role check                              | Procedure derives from `protectedProcedure` instead of `workspaceProcedure`                  | Anywhere you act on a workspace, use `workspaceProcedure('verb')`. Don't bypass.                                    |
| `Property 'workspace' does not exist on type 'Context'`                 | Procedure isn't chained off `workspaceProcedure`                                              | Make sure the chain returns `next({ ctx: { ...ctx, workspace, membership } })`.                                    |
| Two QueryClients in DevTools React-Query panel                          | Day-3 `<QueryClientProvider>` wasn't removed when `<TrpcProvider>` was added                 | Delete the old provider; `TrpcProvider` owns the QueryClient now.                                                  |
| `Cannot find module '@syncra/contracts/server'`                          | Subpath export missing from `libs/contracts/package.json`                                    | Confirm `"exports": { ".": "./src/index.ts", "./server": "./src/server.ts" }`.                                     |
| Frontend hangs on first tRPC call                                       | Vite proxy not forwarding `/api/trpc` (paths starting with `/api` should already be covered) | Confirm `vite.config.mts` has `server.proxy['/api']`; tRPC lives under `/api/trpc`.                                  |
| Big batch GET URL gets rejected (`URI Too Long`)                        | `httpBatchLink` collapses many queries into one GET                                          | For pathologically huge batches, switch to `httpLink` (per-call). Rarely happens in practice.                       |

---

## 14. Tear down (for debugging only)

```sh
# Temporarily disable batching to see individual calls in DevTools:
#   replace httpBatchLink with httpLink in apps/frontend/src/lib/trpc-provider.tsx

# Roll back to REST calls (not recommended; we want the type safety):
#   the old fetch hooks are in your git history.
```
