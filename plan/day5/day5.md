# Day 5 — tRPC End-to-End
*A learner's guide. Today the types stop lying to you.*

---

## Hello again 👋

You spent four days building a real SaaS slice. Sign in, create a workspace, invite teammates. It works.

But it has a quiet, expensive disease. Open any of yesterday's frontend code:

```ts
const res = await fetch('/api/workspaces', { credentials: 'include' });
if (!res.ok) throw new Error(`${res.status}`);
return res.json() as Promise<Workspace[]>;       // ← who said it's a Workspace[]?
```

That `as Promise<Workspace[]>` is **a lie**. TypeScript believes you. But the *server* might return something else. If you rename `displayName` to `fullName` on the backend, TypeScript won't say a word. The frontend silently breaks at runtime.

This is the **types-at-the-edge problem**, and every web app hits it eventually. Today we cure it.

By the end of today, you'll be able to say:

> "Renaming a field on the backend immediately turns red in the frontend. Same for query inputs. Same for response shapes. The types are computed from the actual server code — there's nothing for the two sides to disagree about."

That guarantee changes how fast you can move. Let's build it.

---

## 1. The problem (a tiny story)

Yesterday Alice's workspace list endpoint returned this:

```json
[
  { "id": "...", "slug": "acme", "name": "Acme Inc.", "role": "owner" }
]
```

Now imagine a teammate (or future-you) ships this backend change:

```ts
// before
return { id, slug, name, role };
// after — added a field, renamed another
return { id, slug, displayName: name, role, plan: 'free' };
```

Three things happen:
1. The backend ships. Tests pass.
2. The frontend, unchanged, keeps reading `w.name`. It's `undefined` in production. The workspace switcher renders blank labels.
3. PostHog records a 17% drop in workspace clicks. Someone notices on Tuesday.

This bug was avoidable. The frontend and backend *should* be one program. The fact that they ship to different machines is an implementation detail, not a reason to lose types between them.

---

## 2. Big picture (what we're building today)

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
                │ export type AppRouter = typeof appRouter
                │ ↓ (via TypeScript only — no codegen!)
   ┌────────────▼─────────────────────────────────┐
   │ libs/contracts                                │
   │  re-exports: AppRouter, input/output Zod      │
   └────────────┬─────────────────────────────────┘
                │ pure-type import
                ▼
   ┌──────────────────────────────────────────────┐
   │ apps/frontend                                 │
   │  trpc = createTRPCReact<AppRouter>()          │
   │  trpc.workspace.list.useQuery()  ← fully typed │
   └──────────────────────────────────────────────┘
```

By the end of the day, every backend procedure has the shape:

```ts
workspace: {
  list:   query  → Workspace[]
  create: mutation(input: { slug, name }) → Workspace
  invite: mutation(input: { slug, email, role? }) → { acceptUrl }
  accept: mutation(input: { token }) → { workspaceSlug }
}
me: {
  get: query → Me
}
```

And on the frontend it's:

```tsx
const { data: workspaces } = trpc.workspace.list.useQuery();
const create = trpc.workspace.create.useMutation();
await create.mutateAsync({ slug: 'acme', name: 'Acme Inc.' });
```

Auto-complete works. Renaming a field is a compile error. Wrong input is a compile error. **No `as Type` lies anywhere.**

---

## 3. The 4 new ideas you'll meet today

| Idea                              | One-line summary                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **RPC vs REST**                    | RPC = "call this function on the server". REST = "this is a resource at this URL". Two valid styles.   |
| **Zod as the contract**            | One Zod schema validates the input on the server *and* infers the TypeScript type on the client.        |
| **Type inference end-to-end**     | No codegen. The router's *type* is exported and imported across the network boundary.                  |
| **Procedures (query vs mutation)** | A `query` is safe to retry/cache. A `mutation` changes state. tRPC enforces the difference everywhere. |

---

### 3.1 RPC vs REST — when to use which

REST asks: "what is the URL of the workspace?" Answer: `GET /api/workspaces/acme`.

RPC asks: "what function do I want to call?" Answer: `workspace.get({ slug: 'acme' })`.

Both are fine. They optimise for different things.

**REST shines when:**

- The API is consumed by *strangers* — third parties, command-line tools, language-X clients. Standard HTTP verbs, status codes, cache headers.
- The resource model is the conceptual model — CRUD over things.
- HATEOAS / hypermedia matters (rare).

**RPC shines when:**

- The consumer is *you* (your own SPA). You control both ends.
- The operations don't fit cleanly into noun-shaped resources — `workspace.invite`, `tasks.bulkArchive`, `ai.summarise` are verbs, not URLs.
- You want maximum type safety and minimum boilerplate.

For Syncra:

- **`/v1/*` (public API for customers, Day 32+)** → REST. Third parties expect it.
- **The web SPA's edge (today)** → tRPC. We own both sides.

This split is in `ARCHITECTURE.md §4.1` (the "three lanes" diagram).

---

### 3.2 Zod — your contract, written once

Yesterday's invite endpoint took `{ email: string, role?: 'admin' | 'member' | 'viewer' }`. Today we *write that down* in a Zod schema:

```ts
import { z } from 'zod';

export const InviteInput = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});
export type InviteInput = z.infer<typeof InviteInput>;   // { email: string; role: 'admin' | 'member' | 'viewer' }
```

The schema does three jobs:

1. **Runtime validation** on the server: if the client sends `{ email: 'not-an-email' }`, the server throws *before* your handler runs.
2. **TypeScript type** for the server handler (`InviteInput`).
3. **TypeScript type** for the client (auto-inferred via tRPC — you don't even need the `z.infer` line on the client).

One schema. Three guarantees. Drift becomes impossible.

> Zod isn't tRPC-specific — it's just a great validation library. tRPC uses it because it's the de-facto standard in 2026.

---

### 3.3 Type inference end-to-end — the magic without codegen

The traditional approach (OpenAPI, GraphQL codegen, gRPC) generates *code* from a *schema document*. You run a build step; types appear.

tRPC skips the codegen. Instead:

1. The server exports the **type** of its router: `export type AppRouter = typeof appRouter`.
2. The client imports that type — only the type, not the runtime code.
3. The client uses it to type a stub: `createTRPCReact<AppRouter>()`.
4. Now the stub has every procedure, input, and output typed correctly.

What ships at runtime? Only `fetch` calls to `/api/trpc/workspace.list` (or wherever you mount tRPC). The types exist only in TypeScript-land. Zero bundle cost.

The catch: this only works in a **monorepo** (or with a published `@syncra/contracts` package). The frontend has to import a type from the backend. In our Nx setup, that's a one-line import.

---

### 3.4 Procedures — query vs mutation

tRPC has exactly two procedure kinds:

| Kind         | When to use                              | Behaviour                                                            |
| ------------ | ---------------------------------------- | -------------------------------------------------------------------- |
| **`query`**   | Reads. No side effects. Safe to retry.  | TanStack Query caches, dedupes, refetches on focus.                  |
| **`mutation`** | Writes. State changes.                  | One-shot. Errors surface to the caller. No background caching.        |

Map yesterday's endpoints:

- `GET /api/workspaces` → `workspace.list` (**query**)
- `GET /api/me` → `me.get` (**query**)
- `POST /api/workspaces` → `workspace.create` (**mutation**)
- `POST /api/workspaces/:slug/invitations` → `workspace.invite` (**mutation**)
- `POST /api/invitations/accept` → `invite.accept` (**mutation**)
- `GET /api/workspaces/slug-available` → `workspace.slugAvailable` (**query**)
- `GET /api/workspaces/:slug/members` → `workspace.listMembers` (**query**)

The HTTP verbs disappear; the *intent* gets clearer. `mutation` vs `query` is exactly the semantic verb-vs-noun line, with TanStack Query behaviour matching it for free.

---

## 4. Where tRPC stops and our code starts

Same seam table as Day 3 — tRPC is a tool, not a framework.

| Job                                                      | Done by                                |
| -------------------------------------------------------- | -------------------------------------- |
| Wire up Express request → tRPC procedure dispatch        | `@trpc/server/adapters/express`         |
| Define procedures with `.input(...).query(...)`           | **Our `router.ts`** (we own)            |
| Validate inputs with Zod                                  | tRPC (we provide the schema)            |
| Get `req.user`, `req.workspace`, etc.                     | **Our `createContext`** (we own)        |
| Authorisation (Casbin from Day 4)                         | **Our middleware procedure** (we own)   |
| Serialize/deserialize JSON                                | tRPC                                    |
| Frontend `useQuery`/`useMutation` integration             | `@trpc/react-query` adapter             |
| Cache keys, refetching                                    | TanStack Query (Day 3 setup)            |

Two new patterns you'll write today:

- A **base procedure** (just runs).
- A **protected procedure** (requires `req.user`).
- A **workspace procedure** (requires `req.user` AND `req.workspace` + Casbin check).

Procedures compose. The workspace procedure builds on the protected procedure, which builds on the base. Same pattern as middleware, but typed.

---

## 5. The full picture: one slice end-to-end

What we'll wire together by 5pm today:

```ts
// libs/contracts/src/workspace.ts
export const CreateWorkspaceInput = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(100),
});

// apps/backend/src/trpc/routers/workspace.router.ts
export const workspaceRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    ctx.services.workspaces.listForUser(ctx.user.id)
  ),

  create: protectedProcedure
    .input(CreateWorkspaceInput)
    .mutation(async ({ ctx, input }) => {
      const available = await ctx.services.workspaces.isSlugAvailable(input.slug);
      if (!available) throw new TRPCError({ code: 'CONFLICT', message: 'slug taken' });
      return ctx.services.workspaces.create({ ...input, ownerId: ctx.user.id });
    }),

  invite: workspaceProcedure('workspace:invite')
    .input(InviteInput)
    .mutation(({ ctx, input }) => ctx.services.workspaces.invite({ /* ... */ })),
});

// apps/backend/src/trpc/router.ts
export const appRouter = router({
  me: meRouter,
  workspace: workspaceRouter,
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

If you rename `name` to `displayName` in the Zod schema → red squiggles in the frontend, in your editor, before you save. *That* is the goal.

---

## 6. Common mistakes to watch for

| You do this                                                          | What goes wrong                                                                | The fix                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `import { type AppRouter } from '../../../backend/src/trpc/router'`   | Frontend pulls server runtime code (and its dependencies) into the bundle      | Export *only* the type from `libs/contracts`. Use `export type AppRouter`. Never `export { AppRouter }`. |
| Skip Zod input validation because "the frontend is typed"             | The frontend isn't the only caller — anyone with `curl` becomes the threat     | Always `.input(SomeZodSchema)`. tRPC + Zod is your runtime firewall.                                  |
| Make every procedure a `query`                                        | Mutations get auto-retried by TanStack Query → duplicate invitations          | Reads → `query`, writes → `mutation`. Hard rule.                                                     |
| Throw `new Error('not found')` from a procedure                       | Client gets a generic 500. No type-safe error code.                            | `throw new TRPCError({ code: 'NOT_FOUND', message: 'invitation not found' })`                       |
| Pass user-controlled strings as Zod schemas                           | Logic bug; the server validates against the wrong thing                        | Schemas live in `libs/contracts` — code, not data.                                                  |
| Mount tRPC at a route Auth.js handles (`/api/auth/...`)               | Routes collide; auth breaks                                                    | Mount tRPC at `/api/trpc` (or `/trpc`). Keep it disjoint from `/api/auth/*`.                         |
| Re-implement the workspace middleware inside each procedure           | Middleware drifts; bugs proliferate                                            | One `workspaceProcedure(action)` factory; every workspace-scoped procedure derives from it.           |
| Put the workspace slug in the *body* of the mutation                  | Doesn't match REST instincts; cache keys become awkward                        | Put workspace slug in the `input`. tRPC keys on input — cache works correctly.                       |
| Return `Date` objects directly                                        | JSON loses the type info; client gets a string and calls `.toISOString()` on it | Use `superjson` as the serializer; tRPC handles it.                                                  |

---

## 7. What you ship today

- [ ] `@trpc/server` + `@trpc/server/adapters/express` mounted at `/api/trpc` on backend.
- [ ] `libs/contracts/src/trpc.ts` exports `AppRouter` (type only) and shared Zod input schemas.
- [ ] `apps/backend/src/trpc/` directory with `context.ts`, `trpc-init.ts`, `router.ts`, `routers/{me,workspace}.router.ts`.
- [ ] `protectedProcedure` (asserts `req.user`) and `workspaceProcedure(action)` (resolves slug, asserts membership + Casbin) helpers.
- [ ] Procedures: `me.get`, `workspace.list`, `workspace.slugAvailable`, `workspace.create`, `workspace.invite`, `workspace.listMembers`, `invite.accept`.
- [ ] Frontend `@trpc/client` + `@trpc/react-query` wired with `superjson` and cookie credentials.
- [ ] Yesterday's `fetch` calls replaced with `trpc.*.useQuery/useMutation` — no more `as Workspace[]` casts anywhere.
- [ ] Demo: renaming a field on the backend turns red in the frontend's editor.
- [ ] **ADR 0003** committed: *tRPC for the web edge; REST for the public API*.

---

## 8. Verify (paste-able)

```sh
# 1) Backend exposes the tRPC endpoint
curl -i http://localhost:4200/api/trpc/me.get?batch=1 \
  -H "Cookie: __Host-syncra-session=$COOKIE" | head -10
# → 200 with JSON body containing the user

# 2) Wrong input is rejected with a 400 (not 500)
curl -i -s -X POST 'http://localhost:4200/api/trpc/workspace.create?batch=1' \
  -H "Cookie: __Host-syncra-session=$COOKIE" \
  -H 'content-type: application/json' \
  -d '{"0":{"json":{"slug":"BAD SLUG WITH SPACES","name":""}}}' | head -5
# → 400 Bad Request, body contains Zod validation error

# 3) Frontend type-check: rename a field, confirm errors appear
# In libs/contracts/src/workspace.ts: change `name: z.string()` → `displayName: z.string()`
npx nx run frontend:typecheck
# → red errors in the SPA referencing `.name` field
# (revert the change before continuing)
```

---

## 9. Today's mental shifts

1. **Types at the edge are a deployment artefact, not a manual contract.** Either they're auto-derived from the actual server code (tRPC, gRPC + codegen), or they're a lie someone forgot to update. We pick "derived".
2. **Validation isn't optional, even if the client is typed.** Anyone with `curl` is also a client. Zod runs on the server, every request, no exceptions.
3. **"Procedures" feel like methods, not URLs.** That mindset shift unlocks composability: `workspaceProcedure('workspace:invite').input(...).mutation(...)`. Middleware chains by type, not by Express middleware.
4. **Drift is a process bug, not an inevitability.** Once `libs/contracts` is the single source of truth, drift can't happen. Make that bar non-negotiable for new code.

---

## 10. Journal prompts (5 minutes)

1. Before today, what was your default for "make the frontend talk to the backend"? What changes about that for you now?
2. tRPC ties you to TypeScript on both ends. If a year from now we needed to add a Python data-pipeline client, what would we do?
3. Casbin authorisation lives inside `workspaceProcedure`. Look at the procedure factory — is the auth check obvious enough that a code reviewer would notice if it were missing?

---

## 11. What we did NOT do today (and why)

- **Public API REST endpoints.** Day 32. tRPC is for the SPA only. The public API (with API keys + scopes) is REST per ARCHITECTURE.md §4.1.
- **Subscriptions / SSE / websockets.** tRPC supports them; we don't need them yet. Realtime is Day 15+ (Yjs over Hocuspocus, not tRPC).
- **Server-side rendering.** Pure SPA; no Next.js. ARCHITECTURE.md §15.2 explains why.
- **OpenAPI spec for the SPA edge.** Customers never call tRPC directly; no need.
- **Mutation optimistic updates.** Day 13. Pattern is the same as you'd use for any TanStack Query mutation.

The point of today: **after Day 5, your contracts are code.** Every change is visible in both halves of the app, instantly, in your editor.

---

## 12. Want to read more?

- tRPC docs — https://trpc.io/docs
- tRPC + Express adapter — https://trpc.io/docs/server/adapters/express
- tRPC + React Query — https://trpc.io/docs/client/react
- Zod — https://zod.dev
- TanStack Query mutations — https://tanstack.com/query/latest/docs/framework/react/guides/mutations
- `superjson` (handles Date, Map, Set over JSON) — https://github.com/blitz-js/superjson
- Why pick RPC over REST for SPAs — https://www.youtube.com/watch?v=2LYM8gf184U

---

Good Day 5. Tomorrow Week 1 ends with TanStack Router + shadcn polish. Then Week 2 hits projects, tasks, and the transactional outbox.
