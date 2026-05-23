# Day 2 — Drizzle, Migrations, and Row-Level Security
*A learner's guide. Read it like a story.*

---

## Hello again 👋

Yesterday you booted 16 containers. The database is running, but it's empty. Today we put **tables** inside it, and we make sure that customers can never accidentally see each other's data.

By the end of today you will be able to say:

> "Two different companies use my app. Their data lives in the same database. **Postgres itself** stops one company from seeing the other — even if I write a buggy SQL query."

That guarantee is the most important thing in any SaaS app. We will build it today.

---

## 1. The problem (a tiny story)

Imagine two companies use Syncra:

- **Acme Inc.** — they have 4 tasks.
- **Beta LLC** — they have 6 tasks.

All 10 tasks live in the **same `tasks` table** in the **same database**. That's normal for a SaaS app — one big shared database is cheap, fast, and easy to back up.

Now your developer writes this code:

```ts
// Show the user their tasks
const tasks = await db.select().from(tasks);   // ← oops, no WHERE clause
```

**The bug**: this returns *all 10 tasks*. Acme sees Beta's tasks. Beta sees Acme's tasks. Game over.

**The lesson**: humans forget the `WHERE workspace_id = …` filter. We can't trust ourselves. We need the database itself to refuse to leak data.

That's what **Row-Level Security (RLS)** does. We'll get there.

---

## 2. What we're building today (the big picture)

Picture three layers stacked on top of each other:

```
   ┌────────────────────────────────┐
   │ Your app code (apps/api)        │   "Hey database, give me Acme's stuff"
   └─────────────┬──────────────────┘
                 │
   ┌─────────────▼──────────────────┐
   │ libs/db-kit  (a small library)  │   "OK, I will tell Postgres who you are
   │   ─ Drizzle schema              │    before I run any query"
   │   ─ withCtx(workspaceId, ...)   │
   │   ─ RLS .sql files              │
   └─────────────┬──────────────────┘
                 │
   ┌─────────────▼──────────────────┐
   │ PostgreSQL                       │   "Acme? OK. I will only show you
   │   ─ tables                       │    rows where workspace_id = Acme."
   │   ─ RLS policies                 │
   │   ─ a special role: app_user     │
   └────────────────────────────────┘
```

The middle layer (`libs/db-kit`) is what you build today. It is the **only** way the rest of the app talks to the database. Everyone else asks `db-kit`, never Postgres directly.

---

## 3. The 4 new tools you'll meet today

| Tool             | What it is in one sentence                                                       |
| ---------------- | -------------------------------------------------------------------------------- |
| **Drizzle**      | A small TypeScript library that helps you write SQL safely.                      |
| **RLS**          | A Postgres feature that hides rows from people who shouldn't see them.           |
| **`SET LOCAL`**  | A Postgres command that says "for this one transaction, I am Acme."              |
| **Testcontainers** | A test helper that boots a real Postgres in Docker, just for one test, then throws it away. |

Let's meet each one properly.

---

### 3.1 Drizzle — your translator from TypeScript to SQL

You want to write queries in TypeScript. You also want them to compile to good SQL. Drizzle is the simplest tool for that.

**A quick taste**:

```ts
// Define a table
import { pgTable, uuid, text } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id:    uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  name:  text('display_name'),
});

// Use it
const me = await db.select().from(users).where(eq(users.email, 'alice@acme.com'));
```

That's it. The TypeScript object `users` *is* the schema. There's no separate `schema.prisma` file or magic codegen.

**Why we picked Drizzle and not Prisma**:
- Prisma generates a separate Rust binary that runs your queries. It's amazing for simple CRUD. But it hides SQL too much for what we need (RLS, custom types, raw `SET LOCAL`).
- Drizzle is **thin**. It's almost 1:1 with SQL, so when you need raw SQL (and you will, for RLS) it doesn't fight you.

**Two ways to query in Drizzle**:

```ts
// Way 1 — query builder, looks like SQL
const tasks = await db
  .select()
  .from(tasks)
  .where(eq(tasks.status, 'open'))
  .orderBy(desc(tasks.createdAt))
  .limit(20);

// Way 2 — relational, looks like Prisma
const userWithTasks = await db.query.users.findFirst({
  where: eq(users.id, userId),
  with: { tasks: true },
});
```

You'll use Way 1 most of the time. It's clearer about what SQL is actually running.

---

### 3.2 Row-Level Security — Postgres's bouncer at the door

Imagine a bar with one door. Every drink order goes through that door. The bouncer checks: *are you allowed to see this drink?*

That's RLS. Every `SELECT`, `UPDATE`, and `DELETE` against a protected table goes through a **policy**. The policy is a small SQL expression. If the row doesn't match, the database pretends the row doesn't exist.

**The policy we'll write 3 times today**:

```sql
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspaces_isolation ON workspaces
  FOR ALL                                              -- SELECT, INSERT, UPDATE, DELETE
  TO app_user                                          -- only this role
  USING      (id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (id = current_setting('app.workspace_id', true)::uuid);
```

Translation, in plain English:

- **`ALTER TABLE … ENABLE RLS`** — turn the bouncer on.
- **`FOR ALL`** — all kinds of queries (read and write).
- **`TO app_user`** — apply this rule to the `app_user` role (more on roles in a moment).
- **`USING (...)`** — to read a row, this expression must be `true`.
- **`WITH CHECK (...)`** — to write a row, this expression must be `true`.

The expression is: *"the workspace_id on this row must match the workspace_id we said we are"*. More on `current_setting` next.

**The key point**: even if the app code does `SELECT * FROM workspaces` with NO `WHERE` clause, Postgres rewrites it to:

```sql
SELECT * FROM workspaces WHERE id = current_setting('app.workspace_id', true)::uuid;
```

Without you typing it. Without you remembering. That is defense in depth.

---

### 3.3 `SET LOCAL` — telling Postgres who you are

`current_setting('app.workspace_id', true)` reads a "session variable" called `app.workspace_id`. We have to set it before each request. The command is:

```sql
SET LOCAL app.workspace_id = '6f3...';
```

Two words to understand here:

#### `SET` vs `SET LOCAL`

- `SET app.workspace_id = '...'` — lasts for the **whole connection**. Bad for us.
- `SET LOCAL app.workspace_id = '...'` — lasts only until the **transaction ends**. Then it disappears.

#### Why `SET LOCAL` and not plain `SET`?

Remember PgBouncer from Day 1? It hands the same Postgres connection to many requests, one by one. Like sharing a bus seat.

If Acme's request did `SET app.workspace_id = 'acme-id'` and forgot to clear it, the next person who sat in that seat would still smell like Acme. They'd see Acme's data. **Disaster.**

`SET LOCAL` cannot leak. The moment the transaction ends (`COMMIT`), the value is gone. The seat is wiped clean.

So our rule is: **always wrap RLS-protected queries in a transaction, and always use `SET LOCAL`** (or its parameterized friend `set_config`, see callout below).

We'll write a helper called `withCtx` that does this for us. Sneak peek:

```ts
await withCtx({ workspaceId: 'acme-id', userId: 'alice-id' }, async (tx) => {
  // Inside here, every query against an RLS table only sees Acme's rows.
  const tasks = await tx.select().from(tasks);
});
// Outside here, the SET LOCAL is gone. Postgres has forgotten.
```

Beautiful, right?

> 📝 **Small wrinkle for real code: `set_config()` instead of `SET LOCAL`**
>
> When you write `sql\`SET LOCAL app.workspace_id = ${id}\`` in Drizzle, the driver tries to send the `id` as a **bound parameter** (`$1`). Postgres treats `SET` as a "utility command" and rejects parameters there — you'll get `syntax error at or near "$1"`.
>
> The fix is `set_config(name, value, is_local)`, a normal SQL function that **does** accept parameters and behaves identically:
>
> ```ts
> // ❌ Throws "syntax error at or near $1"
> await tx.execute(sql`SET LOCAL app.workspace_id = ${id}`);
>
> // ✅ Same effect, parameter-safe
> await tx.execute(sql`SELECT set_config('app.workspace_id', ${id}, true)`);
> ```
>
> Conceptually it's still `SET LOCAL`. We just say it via `set_config()` so the value can be a bound parameter (no SQL-injection risk, faster on repeats). All the code in `withCtx` and the tests uses `set_config()`.

---

### 3.4 Two Postgres roles — the secret to making RLS actually work

Postgres has a feature: **superusers and table owners bypass RLS**.

That's a problem. The user `syncra` (which Day 1 created) is the database owner. If our app connects as `syncra`, RLS is silently turned off. The bouncer is asleep.

**The fix**: create a second role called `app_user` that:
- Can read, insert, update, delete — but
- **Cannot** bypass RLS (`NOBYPASSRLS`).
- **Cannot** create tables.

We use `syncra` only for migrations (running schema changes). The actual app uses `app_user`. So even if the developer copy-pastes a query and forgets `WHERE`, RLS is still on, and Postgres returns 0 rows.

```sql
CREATE ROLE app_user NOINHERIT NOBYPASSRLS LOGIN PASSWORD 'app_user';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
```

Two database connection strings, two purposes:

| Connection                                              | Used by             | Bypasses RLS? |
| ------------------------------------------------------- | ------------------- | ------------- |
| `postgresql://syncra:syncra@localhost:6432/syncra`      | migrations only     | Yes (and that's fine — migrations need to)    |
| `postgresql://app_user:app_user@localhost:6432/syncra`  | runtime app code    | **No**       |

---

### 3.5 Testcontainers — a fresh Postgres for every test

How do we know RLS actually works? We test it.

But unit tests with mock databases prove nothing. RLS lives **in Postgres**. We need a real Postgres.

**Testcontainers** is a tiny library that says: "When this test starts, boot a Postgres container. Run my migrations. When the test ends, throw it away." Your laptop runs Docker, so this is fast and free.

```ts
const container = await new PostgreSqlContainer('ankane/pgvector:latest').start();
const url = container.getConnectionUri();
// run migrations against url
// run your test
await container.stop();
```

The test we'll write does exactly the bug from §1:

```ts
test('Acme cannot see Beta', async () => {
  // setup: insert two workspaces using the SUPERUSER (so RLS doesn't block us)
  const [acme] = await superDb.insert(workspaces).values({ name: 'Acme', ... }).returning();
  const [beta] = await superDb.insert(workspaces).values({ name: 'Beta', ... }).returning();

  // act: as app_user, scoped to Acme, run a query with NO where clause
  const visible = await appDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.workspace_id', ${acme.id}, true)`);
    return tx.select().from(workspaces);   // forgot WHERE on purpose
  });

  // assert: only Acme is visible
  expect(visible).toHaveLength(1);
  expect(visible[0].id).toBe(acme.id);
});
```

If this test ever passes when it shouldn't (e.g. returns both rows), we have a security regression.  We will gate this in CI starting today.

---

## 4. The 4 tables we will create

Just enough to start. More tables come on Days 4, 8, etc.

### `users` — humans who use Syncra

```
┌────────────────────────────────────────────────┐
│ users                                          │
├────────┬───────────────────────────────────────┤
│ id     │ uuid (auto-generated)                 │
│ email  │ alice@acme.com                        │
│ name   │ "Alice"                               │
│ ...    │                                        │
└────────────────────────────────────────────────┘
```

A user is a person. They sign up once. They can join many workspaces. **Not workspace-scoped — no RLS on this table** (we control access from the identity module instead).

### `workspaces` — companies / teams

```
┌────────────────────────────────────────────────┐
│ workspaces                                     │
├──────┬─────────────────────────────────────────┤
│ id   │ uuid                                    │
│ slug │ "acme"      ← used in URLs: /w/acme/... │
│ name │ "Acme Inc."                             │
│ ...  │                                          │
└────────────────────────────────────────────────┘
```

A workspace is a tenant. Acme has one. Beta has one. **RLS-protected — you can only see "your" workspace.**

### `workspace_members` — "Alice belongs to Acme as an admin"

```
┌─────────────────────────────────────────────────┐
│ workspace_members                               │
├──────────────┬──────────────┬──────────────────┤
│ workspace_id │ user_id      │ role             │
│ acme_uuid    │ alice_uuid   │ owner            │
│ acme_uuid    │ bob_uuid     │ member           │
│ beta_uuid    │ carol_uuid   │ admin            │
└─────────────────────────────────────────────────┘
```

This is the bridge. It tells us who is in which workspace and what they can do there. **RLS-protected.**

### `invitations` — "we invited dan@acme.com to join Acme"

```
┌─────────────────────────────────────────────────────────┐
│ invitations                                             │
├──────┬──────────────┬──────────┬──────┬────────────────┤
│ id   │ workspace_id │ email    │ role │ expires_at     │
│ inv1 │ acme_uuid    │ dan@... │ member│ in 7 days     │
└─────────────────────────────────────────────────────────┘
```

When you invite someone, we put a row here, send them an email with a secret link. They click it, we accept the invite, we create a `workspace_members` row. **RLS-protected.**

---

## 5. Two kinds of migration files (and why)

A "migration" is a script that changes your database schema. We'll have two kinds today:

### Kind A — generated by Drizzle Kit

```sh
npx drizzle-kit generate
```

This compares your TypeScript schema to what's already applied. It writes a `.sql` file that adds the missing parts. Easy. Boring. Reliable.

We use it for: tables, columns, indexes, foreign keys, defaults.

### Kind B — hand-written `.sql` files

Drizzle Kit doesn't know about RLS policies, role grants, triggers, partitions, or extensions. So we write those by hand.

We name them with numbers ≥ 100 so they sort *after* Drizzle's:

```
libs/db-kit/migrations/
├── 0000_initial_tables.sql      ← Drizzle generated
└── sql/
    ├── 100_role_grants.sql       ← hand: create app_user
    ├── 101_rls_workspaces.sql    ← hand: enable RLS on workspaces
    ├── 102_rls_workspace_members.sql
    └── 103_rls_invitations.sql
```

We write one tiny custom **migration runner** (a Node script) that applies both kinds in lexical order. It tracks what's been applied in a `_drizzle_migrations` table so it never applies the same file twice.

Total runner code: ~60 lines. We'll write it together in the implementation guide.

---

## 6. The hero of today: `withCtx`

Here's the helper that ties everything together. Every request in `apps/api` will use it.

```ts
// libs/db-kit/src/with-ctx.ts
import { sql } from 'drizzle-orm';
import { appDb } from './client';

export type Ctx = { workspaceId: string; userId: string };

export async function withCtx<T>(
  ctx: Ctx,
  fn: (tx: TxLike) => Promise<T>,
): Promise<T> {
  return appDb.transaction(async (tx) => {
    // set_config(name, value, is_local) is `SET LOCAL` you can parameterize.
    await tx.execute(sql`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`);
    await tx.execute(sql`SELECT set_config('app.user_id',      ${ctx.userId},      true)`);
    return fn(tx);
  });
}
```

Read this carefully. It does **four things**:

1. Opens a transaction (so the third arg `true` — "local to transaction" — has anything to scope to).
2. Tells Postgres who we are (`workspace_id` and `user_id`).
3. Runs your function with that scope.
4. Commits — and the local config evaporates with the transaction.

**Example usage** (this is what your endpoints will look like on Day 4+):

```ts
// In the GET /w/acme/tasks handler
app.get('/w/:slug/tasks', async (req, res) => {
  const { workspace, user } = await resolveAuth(req);          // identity module
  const tasks = await withCtx({ workspaceId: workspace.id, userId: user.id }, async (tx) => {
    return tx.select().from(tasksTable);                       // forgot WHERE on purpose
  });
  res.json(tasks);
});
```

Even though we forgot `WHERE workspace_id = …`, the response only contains the user's workspace's tasks. Postgres did the filtering.

**Trap to avoid**:

```ts
// ❌ WRONG — no transaction, plain SET, leaks across PgBouncer
await db.execute(sql`SET app.workspace_id = ${id}`);
const tasks = await db.select().from(tasksTable);
```

Don't do that. Always go through `withCtx`.

---

## 7. The whole flow, end-to-end

```
   1. Browser sends:        GET /w/acme/tasks
                            cookie: session=abc123
                                │
   2. Identity module says:  user = Alice (from session)
                             workspace = Acme (from URL slug)
                                │
   3. Endpoint calls:        withCtx({workspaceId: acmeId, userId: aliceId}, ...)
                                │
   4. withCtx opens TX:      BEGIN
                             SELECT set_config('app.workspace_id', 'acme-id', true)
                             SELECT set_config('app.user_id',      'alice-id', true)
                                │
   5. Your code runs:        SELECT * FROM tasks       ← no WHERE
                                │
   6. Postgres rewrites it:  SELECT * FROM tasks
                              WHERE workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
                                │
   7. Returns 4 rows (Acme's only)
                                │
   8. Transaction ends:      COMMIT
                             ← config gone
                                │
   9. Response goes back:    [task1, task2, task3, task4]
```

Beta's tasks were never even loaded into memory. Postgres filtered them at the storage layer.

---

## 8. Common mistakes to watch for

| You do this                                                | What goes wrong                                          | The fix                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Connect with `syncra` (the superuser) for app code          | RLS is silently bypassed; cross-tenant leak in production | Use `app_user` for runtime; only migrations use `syncra`                   |
| Use `SET app.workspace_id` without `LOCAL`                 | Setting leaks to the next request via PgBouncer          | Always `SET LOCAL` semantics, always inside a transaction (we use `set_config(..., true)`) |
| Try `SET LOCAL app.workspace_id = ${id}` in Drizzle         | Postgres rejects bound parameters in `SET` → `syntax error at or near "$1"` | Use `SELECT set_config('app.workspace_id', ${id}, true)` instead          |
| Write the policy as `current_setting(...)::uuid` (no NULLIF) | When the GUC is unset, `''::uuid` errors instead of returning 0 rows | Use `NULLIF(current_setting('app.workspace_id', true), '')::uuid`        |
| Forget the second arg to `current_setting`                  | If the GUC isn't set, query *errors* instead of returning empty string | Always `current_setting('app.workspace_id', true)` — `true` = "missing is OK" |
| Run migrations through PgBouncer (port 6432)                | `cannot insert multiple commands into a prepared statement` | Migrations connect direct to Postgres on **5435**; the app uses **6432**  |
| Apply RLS to `users`                                        | Sign-up breaks because a brand-new user has no workspace_id yet | `users` has no RLS — its access is enforced by the identity module        |
| Stop the Testcontainers Postgres while pg `Pool` is open    | `terminating connection due to administrator command` (57P01) | Drain pools (`await Promise.allSettled([appPool.end(), superPool.end()])`) **before** `container.stop()` |

---

## 9. What you ship today

By the end of the day:

- [ ] `libs/db-kit` exists, importable as `@syncra/db-kit`.
- [ ] 4 tables in Postgres: `users`, `workspaces`, `workspace_members`, `invitations`.
- [ ] 3 RLS policies (one per workspace-scoped table).
- [ ] An `app_user` role that cannot bypass RLS.
- [ ] `withCtx({workspaceId, userId}, fn)` works.
- [ ] One Testcontainers test proves Acme cannot see Beta — even with a missing `WHERE`.
- [ ] `npm run db:migrate` is idempotent (run it twice, second run is a no-op).
- [ ] **ADR 0001** committed: *Drizzle over Prisma/TypeORM*.

---

## 10. Verify it works (paste these into your terminal)

```sh
# tables exist
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c '\dt'

# 3 policies exist
psql 'postgresql://syncra:syncra@localhost:6432/syncra' \
  -c "SELECT polname, polrelid::regclass FROM pg_policy ORDER BY 2;"

# app_user cannot bypass RLS
psql 'postgresql://syncra:syncra@localhost:6432/syncra' \
  -c "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname='app_user';"
# Expected: rolbypassrls = f

# As app_user with NO context — must return 0 rows (the bouncer says no)
psql 'postgresql://app_user:app_user@localhost:6432/syncra' \
  -c "SELECT * FROM workspaces;"

# Run the integration test
npm test -w @syncra/db-kit
# Expected: 3 passing
```

---

## 11. Today's mental shifts (the lessons)

If you only remember three things:

1. **The database, not the app, is the last line of defense for tenant isolation.** App code can be wrong; RLS still saves you.
2. **Plain `SET` leaks across requests via PgBouncer. Always `SET LOCAL` inside a transaction.** The `withCtx` helper makes this automatic.
3. **Two roles**: a powerful one for migrations (`syncra`), a restricted one for app code (`app_user`). The restricted one **cannot** bypass RLS, by design. This is what makes the tests meaningful.

---

## 12. Journal prompts (5 minutes at the end of the day)

Open `docs/journal/<today>.md` and answer in 2–3 sentences each:

1. The first time I wrote a Drizzle query, was it more like Prisma or more like raw SQL? Did that change how I felt about it?
2. RLS is "the database is your last line of defense". When in your career have you wished for that, but didn't have it?
3. If a teammate added a new tenant-scoped table next week, what's the *one* thing they could forget that would break tenant isolation? How would I make that mistake hard to repeat?

---

## 13. What we did NOT do today (and why)

- **No HTTP endpoints.** That's Day 3 (auth) + Day 4 (workspace endpoints). Today is just the foundation.
- **No `users` policy.** `users` isn't tenant-scoped; access is controlled by the identity module on Day 3.
- **No `projects` or `tasks`.** Day 8. The pattern will be exactly the same — just more tables.
- **No `pg_partman`.** Day 10 (audit table partitioning). Today's tables don't grow unboundedly.
- **No JWT verification or sessions.** Day 3.

The point of today: **after Day 2, no missing `WHERE` clause in your app code can ever leak data between tenants.**

That is a *huge* guarantee. Take a moment to feel good about it. Then close your laptop. Tomorrow you wire identity. ✨

---

## 14. Want to read more? (browse, don't memorise)

- Drizzle ORM intro — https://orm.drizzle.team/docs/overview
- Drizzle Kit migrations — https://orm.drizzle.team/kit-docs/overview
- Postgres RLS docs (read at least the intro) — https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- `current_setting` — https://www.postgresql.org/docs/current/functions-admin.html
- `SET LOCAL` — https://www.postgresql.org/docs/current/sql-set.html
- Testcontainers Node — https://node.testcontainers.org/
