# Day 4 — Workspaces, Memberships, Invitations, Casbin
*A learner's guide. We keep going slow.*

---

## Hello again 👋

Day 3 made the backend know **who** is making a request. But a signed-in user with no workspace can't do anything useful — yesterday's `/api/me` returns a profile, then… you stare at a blank shell. Today we fix that.

By the end of today, you'll be able to say:

> "A brand-new sign-up creates their workspace, picks a URL slug, sends invites to teammates by email, and a teammate clicks the email link to join. Every action checks **who** the user is *and* **what role** they have in **which** workspace. The wrong role gets a 403, not a 500."

That's a SaaS app. Let's build the social layer of it.

---

## 1. The problem (a tiny story)

Yesterday Alice signed in via GitHub. She landed on `/`, saw her name, and… nothing else.

Today's failure cases we have to prevent:

1. **Alice creates "Acme Inc." and is the owner.** Easy case — works.
2. **Alice invites bob@acme.com as a member.** Bob clicks the email link. He's signed in already (also via GitHub). He joins Acme. 
3. **Alice invites carol@acme.com.** Carol has no GitHub account yet. She clicks → goes to GitHub → signs up there → comes back → joins Acme.
4. **Bob tries to invite somebody (he's just a member, not an admin).** Backend returns 403. Frontend hides the button.
5. **Alice's link to invite dan@acme.com was forwarded to mallory@evil.com.** Mallory tries to use it. We need to think hard about this.
6. **Bob bookmarks `/w/acme/members` then signs out.** Visits the link. Sees `/login`, not "you have permission".

The whole rest of the day handles those six cases without bugs.

---

## 2. Big picture (what we're building today)

```
                  ┌─────────────────────────────────┐
                  │ Browser  (apps/frontend)        │
                  │  /onboarding/workspace          │
                  │  /onboarding/invite             │
                  │  /invite/:token                 │
                  │  /w/$slug                       │
                  └────────────┬────────────────────┘
                               │ HTTP/JSON (Day 5: tRPC)
                               ▼
                  ┌─────────────────────────────────┐
                  │ Backend  (apps/backend)         │
                  │ ┌─────────────────────────────┐ │
                  │ │ WorkspaceModule             │ │
                  │ │  create / list / rename     │ │
                  │ │  invite / accept            │ │
                  │ │  list-members               │ │
                  │ └──────┬──────────────────────┘ │
                  │        │ uses                   │
                  │ ┌──────▼──────────────────────┐ │
                  │ │ libs/auth-kit (Casbin)      │ │
                  │ │  @RequireAction('...')      │ │
                  │ │  enforce(user, action, ws)  │ │
                  │ └─────────────────────────────┘ │
                  │ ┌─────────────────────────────┐ │
                  │ │ MailService (Day 1 Mailpit) │ │
                  │ │  sends invitation emails    │ │
                  │ └─────────────────────────────┘ │
                  └──────────────┬──────────────────┘
                                 │ withCtx({ workspaceId, userId })
                                 ▼
                  ┌─────────────────────────────────┐
                  │ Postgres + RLS  (Day 2)         │
                  │  workspaces, workspace_members, │
                  │  invitations                    │
                  └─────────────────────────────────┘
```

Today's deliverables, by file:

```
apps/backend/src/
├── modules/workspace/
│   ├── workspace.module.ts
│   ├── workspace.service.ts            ← create / invite / accept logic
│   ├── workspace.controller.ts         ← REST endpoints (tRPC tomorrow)
│   ├── workspace.middleware.ts         ← reads :slug from URL → sets app.workspace_id
│   └── invitation-token.ts             ← generate / hash / verify
├── modules/mail/
│   └── mail.service.ts                 ← sends invite emails via Mailpit SMTP
└── ...

libs/auth-kit/
├── package.json
├── src/
│   ├── casbin/
│   │   ├── model.conf                  ← RBAC model definition
│   │   └── policy.csv                  ← role → action grants
│   ├── enforcer.ts                     ← Casbin enforcer singleton
│   └── require-action.decorator.ts     ← @RequireAction('workspace:invite')

apps/frontend/src/
├── routes/
│   ├── _onboarding/workspace.tsx       ← create workspace
│   ├── _onboarding/invite.tsx          ← invite teammates
│   ├── invite/$token.tsx               ← accept invitation
│   └── _app/w/$slug/members.tsx        ← member list
└── components/
    └── workspace-switcher.tsx
```

---

## 3. The 4 new ideas you'll meet today

| Idea                                       | One-line summary                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Atomic workspace creation**              | A workspace and its owner row are written in one transaction. Either both land, or neither — never half.        |
| **Hashed invitation tokens**               | We send a secret in email. We store only its hash. Same idea as passwords — a leak doesn't compromise accounts.  |
| **Casbin RBAC**                            | A tiny policy engine: "given a user with role X in workspace W, can they do action Y?"                            |
| **Onboarding-as-a-router-guard**           | A signed-in user with no workspace is redirected to `/onboarding/workspace`. By the router, not by the endpoint. |

---

### 3.1 Atomic workspace creation — the "no orphan row" rule

When Alice clicks "Create workspace", we have to insert **two** rows:

1. `workspaces` — `(id, slug, name, owner_id)` — the workspace itself.
2. `workspace_members` — `(workspace_id, user_id, role='owner')` — Alice is its owner.

If we insert (1) without (2), Alice has a workspace she can't access (RLS blocks her). If we insert (2) without (1), we have a member row pointing to a workspace that doesn't exist.

The fix is one Postgres transaction:

```ts
await withCtx({ workspaceId: '00000000-0000-0000-0000-000000000000', userId: alice.id }, async (tx) => {
  // Note: workspace_id GUC isn't meaningful here yet — we INSERT then add membership.
  // We bypass RLS for workspaces.create by running as the superuser db, or by
  // using a setup tx that doesn't need RLS.
  ...
});
```

Wait — RLS is a problem during create, because Alice's `app.workspace_id` doesn't exist yet (the workspace is being created right now). Two options:

- **A.** Use the *superuser* connection (`db`, not `appDb`) for this specific write. RLS is bypassed; the code itself enforces that Alice can only create workspaces for herself.
- **B.** Set `app.workspace_id` to the newly-generated UUID *inside* the transaction, then insert. RLS's `WITH CHECK` clause will pass because the row matches the GUC.

We use **B** — it stays inside our discipline (always `appDb` + always `withCtx`). The flow:

```sql
BEGIN;
  -- Pre-generate the UUID so we can both INSERT into workspaces AND
  -- set app.workspace_id to it for the WITH CHECK clause to pass.
  SELECT set_config('app.workspace_id', $newWorkspaceId, true);
  SELECT set_config('app.user_id',      $aliceId,        true);
  INSERT INTO workspaces      (id, slug, name, owner_id) VALUES (...);
  INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (...);
COMMIT;
```

If anything throws, both rows roll back. No orphans.

---

### 3.2 Hashed invitation tokens — the "treat it like a password" rule

When Alice invites bob@acme.com, we generate a **secret token** — a random 32-byte string — and put it in the email:

```
Click here to join Acme:
https://syncra.app/invite/r9-jK_3xMz...VqL
```

We don't store that raw token anywhere. We store its **hash**:

```ts
const raw = randomBytes(32).toString('base64url');           // r9-jK_3xMz...VqL
const tokenHash = await argon2.hash(raw);                    // $argon2id$v=19$...

await db.insert(invitations).values({
  workspaceId,
  email: 'bob@acme.com',
  role: 'member',
  tokenHash,                                                  // ← stored
  expiresAt: addDays(new Date(), 7),
});

// raw is included in the email and then thrown away
await mail.sendInvite({ to: 'bob@acme.com', acceptUrl: `https://syncra.app/invite/${raw}` });
```

When Bob clicks the link, we:

1. Look up the invitation by trying to verify each non-accepted invitation's hash against the supplied token.
2. Check it's not expired.
3. Check it's not already accepted.
4. Mark it accepted, insert the `workspace_members` row.

**Why hash the token?**

If a database backup leaks (or a SQL injection drains the table), the attacker gets hashes, not tokens. Hashes can't be used to log in. Same security model as passwords: never store the secret in cleartext.

> The hash-lookup is *O(N)* — we iterate non-accepted invitations and compare. That's fine because invitations are tiny (a workspace has dozens, not millions). For larger lookup tables you'd store a fingerprint prefix and look up by that, then verify the hash.

**Other token rules:**

- **Single-use.** `accepted_at` is set when used; the partial unique index from Day 2 enforces "one open invitation per email per workspace".
- **Short-lived.** 7-day expiry is standard. Calendars beyond that get fuzzy.
- **Bound to email.** The invitation is for `bob@acme.com`. If Bob signs in as a different email, we *don't* let him accept. (Optional — we'll be lenient in dev, but flag it for production hardening.)

---

### 3.3 Casbin — the "can this user do this?" library

So far, every endpoint either accepts a signed-in user (200) or rejects them (401). But:

- Bob is a member; he can read tasks but not invite.
- Alice is owner; she can do anything.
- Carol is a viewer; she can read but not write anything.

This is **authorisation**, distinct from authentication. RBAC = role-based access control.

We *could* write `if (user.role !== 'admin' && user.role !== 'owner') throw 403` everywhere. We don't, because:

- The rules drift across endpoints.
- Adding a new role (e.g. `auditor`) means hunting through code.
- Tests are ad-hoc.

**Casbin** is a small policy engine. You define a **model** (the shape of the question) and a **policy** (the rules):

`model.conf`:

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

Translation:
- A **request** is `(subject, object, action)`. Subject = role; object = resource pattern; action = verb.
- A **policy line** has the same shape: "this role can do this action on this resource".
- The result is `allow` if any policy matches.

`policy.csv`:

```csv
p, owner,  workspace/*, *
p, admin,  workspace/*, workspace:read
p, admin,  workspace/*, workspace:rename
p, admin,  workspace/*, workspace:invite
p, admin,  workspace/*, member:list
p, member, workspace/*, workspace:read
p, member, workspace/*, member:list
p, viewer, workspace/*, workspace:read
```

In code:

```ts
const enforcer = await newEnforcer('model.conf', 'policy.csv');
const allowed = await enforcer.enforce('admin', 'workspace/acme', 'workspace:invite');
// → true
```

In Nest, we wrap this with a decorator:

```ts
@Post(':slug/invitations')
@RequireAction('workspace:invite')                       // ← guard
async invite(@Param('slug') slug: string, @Body() body: InviteDto, @Req() req: Request) {
  // ... if we got here, req.user has 'workspace:invite' on this workspace
}
```

The guard looks up the user's `workspace_members.role` for the workspace they're acting on, then calls Casbin. If `enforce` returns false, the request is rejected with 403.

> Casbin lets us swap the policy without redeploying code — `policy.csv` is data. Day 11 we'll add ABAC bits (time-of-day rules, field-level constraints). Today's RBAC is just the start.

---

### 3.4 Onboarding as a router guard — the "where do I go?" decision

Yesterday a signed-in user with no workspace landed on `/`. Nothing rendered. Today's UX must funnel them into `/onboarding/workspace` instead — not by checking inside every component, but by the **router itself**.

The pattern (TanStack Router):

```ts
// _app.tsx (parent route of every authenticated page)
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.fetchQuery({ queryKey: ['me'] });
    if (!me) throw redirect({ to: '/login' });
    if (me.memberships.length === 0 && !location.pathname.startsWith('/onboarding')) {
      throw redirect({ to: '/onboarding/workspace' });
    }
  },
});
```

Translation: before any `/_app/...` page renders, we check the user is signed in AND has at least one workspace. If not → forced through onboarding.

`/onboarding/workspace` itself is exempt (we check `location.pathname.startsWith('/onboarding')`) — otherwise we'd redirect to onboarding *from* onboarding (infinite loop).

**Three reasons this beats checking inside every page:**

1. **No flash of "blank dashboard".** Redirect happens before render.
2. **One place to change.** Add a new onboarding step? Update the guard, not 12 pages.
3. **URLs work as bookmarks.** A user bookmarks `/w/acme/tasks`, signs out, comes back. The guard handles the redirect. The component knows nothing.

We covered this in `ARCHITECTURE.md §16.5.4` if you want the full chain.

---

## 4. The four core flows (end-to-end)

### Flow A — Create the first workspace

```
1. Alice signs in (Day 3)                     → cookie set, /api/me returns user, memberships=[]
2. Router guard: memberships=[]                → redirect /onboarding/workspace
3. Alice enters slug "acme" + name "Acme Inc."
   Frontend debounces: GET /api/workspaces/slug-available?slug=acme  → { available: true }
4. Submit: POST /api/workspaces { slug, name }
   Backend:
     BEGIN
       SET LOCAL app.workspace_id = $newId
       SET LOCAL app.user_id      = alice.id
       INSERT workspaces (id, slug, name, owner_id)
       INSERT workspace_members (workspace_id, user_id, role='owner')
     COMMIT
   → { workspaceId, slug }
5. Frontend navigate /onboarding/invite
```

### Flow B — Invite teammates

```
1. Alice on /onboarding/invite enters ['bob@acme.com', 'carol@acme.com']
2. Frontend: POST /api/workspaces/acme/invitations { emails, role: 'member' }
3. Backend (after Casbin says workspace:invite is allowed):
     for each email:
       raw = randomBytes(32)
       hash = argon2.hash(raw)
       INSERT invitations (workspace_id, email, role, token_hash, invited_by, expires_at=now+7d)
       mail.sendInvite({ to: email, acceptUrl: `${ORIGIN}/invite/${raw}` })
4. Mailpit (http://localhost:8025) shows the emails. We can read them in dev.
5. Frontend navigate /w/acme/  (workspace home)
```

### Flow C — Accept an invitation

```
1. Bob opens his email in Mailpit, clicks the link → /invite/r9-jK_3xMz...
2. Router guard:
     If Bob not signed in → store token in URL, redirect /login
     After /login → redirect back to /invite/r9-jK_3xMz...
3. Frontend: POST /api/invitations/accept { token: 'r9-jK_3xMz...' }
4. Backend:
     scan invitations WHERE accepted_at IS NULL AND expires_at > now()
     for each: argon2.verify(row.token_hash, token)  → first match wins
     INSERT workspace_members (workspace_id, user_id=req.user.id, role=row.role)
     UPDATE invitations SET accepted_at = now() WHERE id = row.id
5. Backend response → { workspaceSlug: 'acme' }
6. Frontend navigate /w/acme/
```

### Flow D — List members

```
1. Alice on /w/acme/members
2. Workspace middleware: read :slug=acme from URL → look up workspace.id by slug →
   assert req.user is a member → req.workspace = ws
3. @RequireAction('member:list') guard → Casbin enforce(member-role, workspace/acme, member:list) → true
4. Endpoint: withCtx({ workspaceId: ws.id, userId: req.user.id }, tx => tx.select().from(workspaceMembers))
5. Response: [{ user, role, joinedAt }, ...]
```

---

## 5. Common mistakes to watch for

| You do this                                                                   | What goes wrong                                                                                  | The fix                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Create the workspace, then in a separate request add the member                | Network blip between the two requests → workspace with no members → user locked out               | One transaction. INSERT workspace + member together.                                                               |
| Store the raw invitation token in the DB                                       | DB leak = every invitation is a usable login link                                                | Hash with argon2; store only the hash. Email contains the raw token once.                                          |
| Look up invitations by `email` (string match)                                  | Mallory grabs the URL and uses it from a different email account                                  | Lookup by token hash. The token IS the proof. (Optionally also assert email matches — defense in depth.)            |
| Trust the route param `:slug` directly as the tenant scope                     | Bob crafts a URL to a workspace he isn't in — and your endpoint trusts it                         | Workspace middleware: look up by slug, **assert membership**, then set `app.workspace_id`                          |
| Check role with `if (user.role === 'admin')` in every endpoint                  | Drifts as roles evolve; new roles need a sweep                                                   | Casbin. One policy file. One `@RequireAction('workspace:invite')`.                                                |
| Render the dashboard component and `useEffect`-redirect-on-no-workspace        | Flash of blank dashboard before redirect; user-confusing                                          | Router guard (`beforeLoad`) redirects *before* render                                                              |
| Forget the `?token=` survives `/login` redirect                                | Bob clicks invite → /login → signs in → lands on `/`, invitation forgotten                       | Store the token in `next` query param; restore after sign-in                                                       |
| Use `email` as the global identifier for invitations                          | Carol signs up with a new email (gmail vs work) and can't be matched                              | Bind to email *at invite time*. On accept, JIT-create user even if a row exists under a different email.            |
| Send the email synchronously inside the request                                | API endpoint timeouts when SMTP is slow                                                          | Enqueue (BullMQ on Day 30) or fire-and-forget in dev. Don't block the response.                                    |
| `import { eq, and, sql } from 'drizzle-orm'` directly in a backend service     | Dual-package hazard — backend (CJS) sees a different `SQL<unknown>` from db-kit (ESM)            | Always `import { ..., eq, and, sql } from '@syncra/db-kit'`. Rule set on Day 3; applies to every new service from here on. |

---

## 6. What you ship today

- [ ] `apps/backend/src/modules/workspace/*` — create, rename, invite, accept, list members.
- [ ] `apps/backend/src/modules/mail/*` — sends invitation emails via Mailpit SMTP.
- [ ] `libs/auth-kit` — Casbin model + policy.csv + `@RequireAction()` decorator.
- [ ] Workspace middleware that resolves `:slug` → workspace, asserts membership, sets `app.workspace_id`.
- [ ] Invitation tokens: argon2-hashed, 7-day TTL, single-use.
- [ ] Frontend `/onboarding/workspace` with live slug-availability check (debounced).
- [ ] Frontend `/onboarding/invite` with multi-email form + skip.
- [ ] Frontend `/invite/:token` that handles sign-in-first redirect.
- [ ] Frontend `/w/$slug/members` member list.
- [ ] Frontend workspace switcher in the app header.
- [ ] Demo flow works end-to-end in <90s (per ARCHITECTURE.md §16.5).

---

## 7. Verify (the demo)

```sh
# 1) Backend + frontend up
npx nx serve backend
npx nx serve frontend

# 2) Sign in as user A in one browser (or incognito profile)
open http://localhost:4200/login → GitHub → land on /onboarding/workspace

# 3) Create workspace "acme"
# 4) Invite user-b@example.com → check Mailpit at http://localhost:8025
# 5) In another incognito profile, click the magic link → sign in as B → land on /w/acme

psql 'postgresql://syncra:syncra@localhost:6432/syncra' <<SQL
SELECT slug, name FROM workspaces;
SELECT w.slug, u.email, m.role FROM workspace_members m
  JOIN workspaces w ON w.id = m.workspace_id
  JOIN users u ON u.id = m.user_id;
SELECT email, accepted_at IS NOT NULL AS accepted FROM invitations;
SQL
# 1 workspace, 2 members (one owner, one member), 1 accepted invitation
```

---

## 8. Today's mental shifts

1. **Authentication ≠ authorisation.** Yesterday answered *who*. Today answers *what they can do*. Two separate stacks: cookies → Day 3. Casbin → today.
2. **Hash anything secret you store.** Invitation tokens, API keys (Day 32), webhook secrets (Day 33). Same rule, same reason: a DB leak shouldn't be game-over.
3. **Atomicity beats compensating logic.** "Two writes in one transaction" beats "two writes and a cleanup job for when the second one fails". Always.
4. **Guards beat checks-inside-components.** The router decides who sees what *before* anything renders. Less code, no flash, bookmarkable URLs.

---

## 9. Journal prompts (5 minutes)

1. Casbin has roles, ABAC, time-based rules, conditional rules. We use only the simplest layer today. When do you think we'll need more?
2. The invitation flow is one of the most "leaky" UX surfaces in any SaaS. What edge cases worried you most today, and which did we actually handle?
3. If you were building a B2C app (no workspaces, just users), how much of today would still apply?

---

## 10. What we did NOT do today (and why)

- **tRPC**. Day 5. Today's endpoints are plain REST so we can verify with `curl`.
- **Audit events.** Day 9 (outbox) + Day 10 (audit consumer). Today's writes happen but don't emit `workspace.created` to NATS yet.
- **Tasks, projects, custom fields.** Day 8 onward.
- **SSO / SAML.** Week 11. Today we trust GitHub via Auth.js.
- **Email background queue.** Day 30. Today we send inline (dev only — fine for Mailpit).
- **Plan tiers / quotas.** Out of scope (ARCHITECTURE.md §1.4 SaaS posture).
- **Workspace transfer.** Owner-change flow is a real lifecycle event we'll add later. Not in 80-day plan.

The point of today: **after Day 4, a SaaS sign-up is end-to-end real.** Sign up → create workspace → invite → join. Yesterday was "you're logged in". Today is "you're in a team".

---

## 11. Want to read more?

- Casbin RBAC tutorial — https://casbin.org/docs/rbac
- Casbin model syntax — https://casbin.org/docs/syntax-for-models
- Argon2 in Node — https://github.com/ranisalt/node-argon2
- TanStack Router `beforeLoad` — https://tanstack.com/router/latest/docs/framework/react/guide/authenticated-routes
- OWASP token storage guidelines — https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- The "secure invitation tokens" pattern — https://fly.io/blog/api-tokens-a-tedious-survey/

---

Good Day 4. Tomorrow we replace the REST endpoints with tRPC and end the week with a fully type-safe edge.
