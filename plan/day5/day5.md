# Day 5 — tRPC End-to-End
*A learner's guide. Today we stop the types from lying.*

---

## Hello again 👋

Four days in, you have a working SaaS slice. Sign in, create a workspace, invite teammates, list members. It all runs. The frontend talks to the backend, the backend talks to the database, the database refuses to leak data between tenants.

But there's a problem hiding in plain sight. Open any frontend file you wrote yesterday and look at this:

```ts
const res = await fetch('/api/workspaces', { credentials: 'include' });
if (!res.ok) throw new Error(`${res.status}`);
return res.json() as Promise<Workspace[]>;
//                ^^^^^^^^^^^^^^^^^^^^^^^
//                you told TypeScript this. nobody checked.
```

That last line is **a lie**. TypeScript believes you. But the *server* might return something completely different. If you change `displayName` to `fullName` on the backend tomorrow, the frontend silently breaks in production. No error in your editor. No test fails. Customers see blank names.

Today we cure that, once and forever.

By the end of today, you'll be able to say:

> "I renamed a field on the backend. My editor immediately showed me every place on the frontend that needed updating. There is no way to silently break the contract anymore."

That guarantee changes how fast you can move. Let's earn it.

---

## 1. The problem (a tiny story)

Yesterday Alice's `/api/workspaces` endpoint returned this:

```json
[
  { "id": "...", "slug": "acme", "name": "Acme Inc.", "role": "owner" }
]
```

The frontend reads `w.name` to render the workspace label.

Now imagine a teammate ships this backend change:

```ts
// before
return { id, slug, name, role };

// after — they added a field and renamed another
return { id, slug, displayName: name, role, plan: 'free' };
```

Three things happen:

1. The backend ships. Every test passes — there are no tests covering this exact shape.
2. The frontend, unchanged, keeps reading `w.name`. It's `undefined` in production. The workspace switcher renders blank labels.
3. Some Tuesday, PostHog tells you workspace clicks dropped 17%. You scratch your head.

This is the **types-at-the-edge problem**. Every web app hits it. Today we close it.

---

## 2. Big picture (what we're building today)

Think of three "pipes" between your backend and frontend:

```
   ┌──────────────────────────────────────────────┐
   │ apps/backend (NestJS)                         │
   │ ┌──────────────────────────────────────────┐ │
   │ │ src/trpc/                                 │ │
   │ │   context.ts   ← per-request data         │ │
   │ │   router.ts    ← all procedures           │ │
   │ │   trpc-init.ts ← shared procedure helpers │ │
   │ └──────────┬───────────────────────────────┘ │
   └────────────┼─────────────────────────────────┘
                │
                │  export type AppRouter = typeof appRouter
                │  ↓  (TypeScript only — no codegen step!)
                │
   ┌────────────▼─────────────────────────────────┐
   │ libs/contracts                                │
   │  re-exports the AppRouter TYPE + Zod schemas  │
   └────────────┬─────────────────────────────────┘
                │ pure-type import
                ▼
   ┌──────────────────────────────────────────────┐
   │ apps/frontend                                 │
   │  trpc = createTRPCReact<AppRouter>()          │
   │  trpc.workspace.list.useQuery()  ← fully typed │
   └──────────────────────────────────────────────┘
```

By the end of the day, every backend operation looks like this:

```ts
workspace: {
  list:        query  → Workspace[]
  create:      mutation(input: { slug, name }) → Workspace
  invite:      mutation(input: { slug, email, role? }) → { acceptUrl }
  slugAvailable: query(input: { slug }) → { available }
  listMembers: query(input: { slug }) → Member[]
}
me: {
  get: query → Me
}
invite: {
  accept: mutation(input: { token }) → { workspaceSlug }
}
```

And on the frontend, every call is:

```tsx
const { data: workspaces } = trpc.workspace.list.useQuery();

const create = trpc.workspace.create.useMutation();
await create.mutateAsync({ slug: 'acme', name: 'Acme Inc.' });
//                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                       typed against the SAME zod schema the server checks
```

Auto-complete works everywhere. Renaming a field is a compile error. Sending bad input is a compile error. **No `as Type` lies anywhere.**

---

## 3. The 4 new ideas you'll meet today

| Idea                              | One-line summary                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **RPC vs REST**                    | RPC = "call this function on the server". REST = "this is a resource at this URL". Two valid styles, different jobs. |
| **Zod as the contract**            | One Zod schema validates the input *on the server* AND infers the TypeScript type *on the client*. One source of truth. |
| **Type inference end-to-end**     | No codegen. The server exports the router's *type*; the client imports it. The wire is just `fetch`.            |
| **Query vs mutation**             | `query` = safe read, can be cached/retried. `mutation` = write, changes state. tRPC enforces the difference.    |

Let me meet each one properly.

---

### 3.1 RPC vs REST — when to use which

These are two ways of asking the server to do something.

**REST asks**: *"what's the URL of the workspace?"*
**Answer**: `GET /api/workspaces/acme`.

**RPC asks**: *"which function on the server do I want to call?"*
**Answer**: `workspace.get({ slug: 'acme' })`.

Both are fine. They optimise for different things.

**REST shines when:**

- The API is consumed by *strangers* — third parties, command-line tools, language-X clients. Standard HTTP verbs, status codes, cache headers — predictable across every ecosystem.
- The resource model IS the conceptual model. CRUD over things.

**RPC shines when:**

- The consumer is *you* (your own SPA). You control both ends.
- Operations don't fit neatly into "noun" URLs — `workspace.invite`, `tasks.bulkArchive`, `ai.summarise` are verbs, not URLs.
- You want maximum type safety and minimum boilerplate.

For Syncra:

| Surface                                        | Style we use                                |
| ---------------------------------------------- | ------------------------------------------- |
| **`/v1/*`** — public API for customers (Day 32+) | REST. Third parties expect it.              |
| **Web SPA edge** (today)                        | **tRPC**. We own both sides.                |

This split is in `ARCHITECTURE.md §4.1` (the "three lanes" diagram).

> **Mental shift**: pick the right style for the *consumer*. Strangers like REST. You like RPC.

---

### 3.2 Zod — your contract, written once

Yesterday your invite endpoint took `{ email: string, role?: 'admin' | 'member' | 'viewer' }`. We just kind of *trusted* that's what would come in. Today we **write it down** in a Zod schema:

```ts
import { z } from 'zod';

export const InviteInput = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});
export type InviteInput = z.infer<typeof InviteInput>;
//          ^^^^^^^^^^^
//   { email: string; role: 'admin' | 'member' | 'viewer' }
```

This one schema does three jobs:

1. **Runtime validation** on the server. If the client sends `{ email: 'not-an-email' }`, tRPC throws *before* your handler runs.
2. **TypeScript type** for the server handler. Auto-complete on `input.email`.
3. **TypeScript type** for the client. Auto-complete on `create.mutate({ ... })`.

One schema. Three guarantees. Drift becomes physically impossible.

> Zod isn't tRPC-specific — it's just an excellent validation library. tRPC uses it because the TypeScript ecosystem agreed Zod is the standard around 2024.

---

### 3.3 Type inference end-to-end — the magic without codegen

The traditional approach (OpenAPI, GraphQL with codegen, gRPC) generates *code* from a *schema document*. You run a build step; types appear. Sometimes the codegen breaks. Sometimes you forget to re-run it.

**tRPC skips the codegen entirely.** The trick:

1. The server exports the **type** of its router:
   ```ts
   export type AppRouter = typeof appRouter;
   ```
2. The client imports that type — **only the type**, not the runtime code:
   ```ts
   import type { AppRouter } from '@syncra/contracts/server';
   ```
3. The client uses the type to build a stub:
   ```ts
   export const trpc = createTRPCReact<AppRouter>();
   ```
4. Now the stub has every procedure, every input, every output, all typed exactly the same as the server.

What ships in the bundle at runtime? Just `fetch` calls to `/api/trpc/workspace.list` and similar. The types live only in TypeScript-land. Zero bundle cost.

**The catch**: this only works in a **monorepo** (or with a published `@syncra/contracts` package). The frontend has to import a type from the backend. We have an Nx workspace, so it's a one-line import.

> **Mental shift**: types-at-the-edge become a *deployment artifact* (derived from server code), not a *manual contract* (something the team is supposed to update).

---

### 3.4 Procedures — query vs mutation

tRPC has exactly two kinds of operations:

| Kind         | When to use                              | Behaviour                                                            |
| ------------ | ---------------------------------------- | -------------------------------------------------------------------- |
| **`query`**   | Reads. No side effects. Safe to retry.  | TanStack Query caches, dedupes, refetches on focus.                  |
| **`mutation`** | Writes. State changes.                  | One-shot. Errors surface to the caller. No background caching.        |

Map yesterday's REST endpoints to today's procedures:

- `GET /api/workspaces` → `workspace.list` (**query**)
- `GET /api/me` → `me.get` (**query**)
- `POST /api/workspaces` → `workspace.create` (**mutation**)
- `POST /api/workspaces/:slug/invitations` → `workspace.invite` (**mutation**)
- `POST /api/invitations/accept` → `invite.accept` (**mutation**)
- `GET /api/workspaces/slug-available` → `workspace.slugAvailable` (**query**)
- `GET /api/workspaces/:slug/members` → `workspace.listMembers` (**query**)

The HTTP verbs disappear; the *intent* gets clearer. `mutation` vs `query` is exactly the verb-vs-noun line, with TanStack Query behaviour matching it for free.

---

## 4. Where tRPC stops and our code starts

Same seam table as Day 3 — tRPC is a tool, not a framework. It handles the boring parts; we keep ownership of the interesting parts.

| Job                                                      | Done by                                |
| -------------------------------------------------------- | -------------------------------------- |
| Wire up Express request → tRPC procedure dispatch        | `@trpc/server/adapters/express`         |
| Define procedures with `.input(...).query(...)`          | **Our `router.ts`** (we own)            |
| Validate inputs with Zod                                  | tRPC (we provide the schema)            |
| Get `req.user`, `req.workspace`, etc.                     | **Our `createContext`** (we own)        |
| Authorisation (Casbin from Day 4)                         | **Our `workspaceProcedure` middleware** (we own) |
| Serialize / deserialize JSON                              | tRPC                                    |
| Frontend `useQuery` / `useMutation` integration           | `@trpc/react-query` adapter             |
| Cache keys, refetching                                    | TanStack Query (from Day 3)             |

We'll write **three procedure helpers** today:

- `publicProcedure` — anyone can call (rare).
- `protectedProcedure` — must have `req.user` (most procedures).
- `workspaceProcedure(action)` — must be a workspace member AND pass Casbin (everything tied to a workspace).

Procedures **compose**. The workspace one is built on top of the protected one, which is built on top of the public one. Same pattern as Day 3's middleware chain, but typed.

---

## 5. The whole picture: one slice end-to-end

What we'll wire together by end of day:

```ts
// libs/contracts/src/workspace.schema.ts
export const CreateWorkspaceInput = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(100),
});

// apps/backend/src/trpc/routers/workspace.router.ts
export const workspaceRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    ctx.services.workspaces.listForUser(ctx.user.id),
  ),

  create: protectedProcedure
    .input(CreateWorkspaceInput)
    .mutation(async ({ ctx, input }) => {
      const ok = await ctx.services.workspaces.isSlugAvailable(input.slug);
      if (!ok) throw new TRPCError({ code: 'CONFLICT', message: 'slug taken' });
      return ctx.services.workspaces.create({ ...input, ownerId: ctx.user.id });
    }),

  invite: workspaceProcedure('workspace:invite')
    .input(InviteInput)
    .mutation(({ ctx, input }) =>
      ctx.services.workspaces.invite({ /* ... */ })
    ),
});

// apps/backend/src/trpc/router.ts
export const appRouter = router({
  me: meRouter,
  workspace: workspaceRouter,
  invite: inviteRouter,
});
export type AppRouter = typeof appRouter;
```

```ts
// apps/frontend/src/lib/trpc.ts
import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@syncra/contracts/server';
export const trpc = createTRPCReact<AppRouter>();
```

```tsx
// somewhere on the frontend
const { data: workspaces } = trpc.workspace.list.useQuery();
const create = trpc.workspace.create.useMutation();
await create.mutateAsync({ slug: 'acme', name: 'Acme Inc.' });
//                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                       typed AGAINST the Zod schema on the server
```

Rename `name` to `displayName` in the Zod schema. Squiggly red lines appear in every frontend file that read `.name`. **That** is what we're chasing.

---

## 6. The full request flow (end-to-end)

Imagine Alice clicks the "Members" link on `/w/acme`. Here's what happens:

```
   1. Browser:               GET /api/trpc/workspace.listMembers?input=...
                             Cookie: authjs.session-token=...
                                │
   2. Vite proxy:            forwards to localhost:3000/api/trpc/...
                                │
   3. Backend identity:      reads cookie → req.user = { id: alice-uuid }
                                │
   4. tRPC dispatcher:       looks up "workspace.listMembers" in appRouter
                                │
   5. workspaceProcedure:    reads `slug` from the input
                             → findBySlug('acme') (cross-tenant, via db)
                             → getMembership(ws.id, alice.id) (per-tenant, via appDb)
                             → Casbin.can('owner', 'acme', 'member:list') → true
                                │
   6. Procedure body:        ctx.services.workspaces.listMembers(...)
                             → withCtx → SET LOCAL app.workspace_id
                             → SELECT FROM workspace_members
                                │
   7. tRPC serialiser:       JSON-encodes the response (via superjson)
                                │
   8. Browser receives:      [{userId, role, displayName, email, ...}]
                             → TanStack Query caches it
                             → React re-renders the member list
```

That's the full Day-1-through-Day-5 stack in one request. Beautiful.

---

## 7. Common mistakes to watch for

| You do this                                                          | What goes wrong                                                                                  | The fix                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `import { type AppRouter } from '../../../backend/src/trpc/router'`   | Frontend bundle pulls in server-runtime code by accident; build balloons and may even break        | Export *only* the type from `libs/contracts/server`. Use `export type { AppRouter }`. Never `export { AppRouter }`. |
| Skip Zod input validation because "the frontend is typed"             | The frontend isn't the only caller — anyone with `curl` is also a client                          | Always `.input(SomeZodSchema)`. tRPC + Zod is your **runtime** firewall.                                          |
| Make every procedure a `query`                                        | Mutations get auto-retried by TanStack Query → duplicate invitations sent                         | Reads → `query`. Writes → `mutation`. Hard rule.                                                                 |
| Throw `new Error('not found')` from a procedure                       | Client gets a generic 500. No structured error code.                                              | `throw new TRPCError({ code: 'NOT_FOUND', message: 'invitation not found' })`. tRPC translates the code to HTTP. |
| Mount tRPC at a route Auth.js handles (`/api/auth/...`)               | Routes collide; auth breaks                                                                       | Mount tRPC at `/api/trpc`. Keep it disjoint from `/api/auth/*`.                                                  |
| Re-implement the workspace middleware inside each procedure           | Casbin checks drift; bugs proliferate                                                              | One `workspaceProcedure(action)` factory. Every workspace-scoped procedure derives from it.                       |
| Return `Date` objects directly                                        | JSON loses the Date type; client gets a string and calls `.toISOString()` on it (which throws)    | Use `superjson` as the transformer on both ends. tRPC handles Date, Map, Set, BigInt natively.                   |
| Forget the `slug` field on workspace-scoped procedure inputs          | The `workspaceProcedure` middleware can't tell which workspace the call is for                    | Every workspace-scoped procedure has a `z.object({ slug, ... })` input. The factory reads `input.slug` to resolve the workspace. |
| Put two `<QueryClientProvider>` components in the tree                 | Two caches, one confused dev. Invalidations work in one, not the other.                            | Delete the Day-3 provider when you add `TrpcProvider`. The new provider owns the QueryClient.                    |

---

## 8. What you ship today

- [ ] `@trpc/server` mounted at `/api/trpc` on backend, after `cookie-parser` and `/api/auth/*`.
- [ ] `libs/contracts/src/*.schema.ts` — Zod schemas for every input.
- [ ] `libs/contracts/src/server.ts` — type-only re-export of `AppRouter`.
- [ ] `apps/backend/src/trpc/` — `context.ts`, `trpc-init.ts`, `router.ts`, `routers/{me,workspace,invite}.router.ts`.
- [ ] `protectedProcedure` and `workspaceProcedure(action)` helpers.
- [ ] Procedures: `me.get`, `workspace.list`, `workspace.slugAvailable`, `workspace.create`, `workspace.invite`, `workspace.listMembers`, `invite.accept`.
- [ ] Frontend: `TrpcProvider` wrapping `QueryClientProvider`; one QueryClient total.
- [ ] Day-4 `fetch` calls in onboarding + workspace pages migrated to `trpc.*.useQuery/useMutation`.
- [ ] Type-safety smoke test: rename a field in a Zod schema → red squigglies in the SPA.
- [ ] **ADR 0003** committed: *tRPC for the web edge; REST for the public API*.

---

## 9. Verify (paste-able)

```sh
# 1) Backend exposes the tRPC endpoint
curl -i 'http://localhost:4200/api/trpc/me.get?batch=1&input=%7B%220%22%3A%7B%7D%7D' \
  -H "Cookie: authjs.session-token=$COOKIE" | head -10
# → 200, JSON body with your user

# 2) Wrong input is rejected with a 400 (not a 500)
curl -i -s -X POST 'http://localhost:4200/api/trpc/workspace.create?batch=1' \
  -H "Cookie: authjs.session-token=$COOKIE" \
  -H 'content-type: application/json' \
  -d '{"0":{"json":{"slug":"BAD SLUG WITH SPACES","name":""}}}' | head -10
# → 400 Bad Request, Zod error in the response body

# 3) Type-safety smoke test
#    Open libs/contracts/src/workspace.schema.ts
#    Rename `name` → `displayName`
#    Save the file.
npm run frontend  # If this is still running, just refresh.
npx nx run frontend:typecheck
# → red errors on every line that reads `.name` in the SPA.
# Revert the change before continuing.
```

---

## 10. Today's mental shifts

1. **Types at the edge are an artefact, not a manual contract.** Either derived from server code (tRPC, gRPC + codegen), or a lie someone forgot to update. We pick "derived".
2. **Validation isn't optional even if the client is typed.** Anyone with `curl` is also a client. Zod runs on the server, every request, no exceptions.
3. **"Procedures" feel like methods, not URLs.** That shift unlocks composability: `workspaceProcedure('workspace:invite').input(...).mutation(...)`. The auth chain reads top-to-bottom and is fully typed.
4. **Drift is a process bug, not an inevitability.** Once `libs/contracts` is the single source of truth, drift can't happen. Hold that bar firm for every new procedure.

---

## 11. Journal prompts (5 minutes)

Open `docs/journal/<today>.md`. 2–3 sentences each:

1. Before today, what was your default for "make the frontend talk to the backend"? What changes about that for you now?
2. tRPC ties you to TypeScript on both ends. If a year from now we needed to add a Python data-pipeline client, what would we do?
3. Casbin's `workspaceProcedure(action)` factory is where the auth check now lives. Look at it — is the auth check obvious enough that a reviewer would notice if you forgot to put a procedure under it?

---

## 12. What we did NOT do today (and why)

- **Public API REST endpoints.** Day 32. tRPC is for the SPA only. Public API needs API keys + scopes + REST style (per ARCHITECTURE.md §4.1).
- **Subscriptions / SSE / WebSockets.** tRPC supports them; we don't need them yet. Realtime is Day 15+ (Yjs over Hocuspocus, not tRPC).
- **Server-side rendering.** We're a pure SPA; no Next.js. ARCHITECTURE.md §15.2 explains the reasoning.
- **OpenAPI spec for the SPA edge.** Customers never call tRPC directly; no need.
- **Optimistic updates.** Day 13. Pattern is the standard TanStack Query one.
- **Removing the existing REST endpoints.** Keep them for now — Day 4's manual flows still work. Once tRPC has full coverage we can prune them in a focused PR.

The point of today: **after Day 5, contracts are code.** Every change is visible in both halves of the app, instantly, in your editor.

---

## 13. Want to read more?

- tRPC docs — https://trpc.io/docs
- tRPC + Express adapter — https://trpc.io/docs/server/adapters/express
- tRPC + React Query — https://trpc.io/docs/client/react
- Zod — https://zod.dev
- TanStack Query mutations — https://tanstack.com/query/latest/docs/framework/react/guides/mutations
- `superjson` (handles Date / Map / Set / BigInt over JSON) — https://github.com/blitz-js/superjson
- "Why pick RPC over REST for SPAs" — https://www.youtube.com/watch?v=2LYM8gf184U
- ADR 0003 (you write this today) — `docs/adr/0003-trpc-over-rest-for-web-edge.md`

---

Good Day 5. Tomorrow Week 1 closes with TanStack Router polish + shadcn/ui. Then Week 2 hits projects, tasks, and the transactional outbox.
