# Day 2 — Implementation

## 0. Pre-flight

```sh
nvm use 24
node --version          # v24.x
docker compose ps       # all Day-1 containers Up
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c 'SELECT 1'
```

---

## 1. Scaffold `libs/db-kit`

```sh
mkdir -p libs/db-kit/src/schema libs/db-kit/migrations/sql libs/db-kit/test libs/db-kit/bin
cd libs/db-kit
```

Make sure `libs/*` is listed in the **root** `package.json`'s `workspaces` array:

```json
{
  "workspaces": ["apps/*", "libs/*", "packages/*"]
}
```

> **Trap**: do **not** add a `workspaces` field inside `libs/db-kit/package.json` itself. That field only belongs at the monorepo root.

`libs/db-kit/package.json`:

```json
{
  "name": "@syncra/db-kit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".":         "./src/index.ts",
    "./schema":  "./src/schema/index.ts",
    "./migrate": "./src/migrate.ts"
  },
  "scripts": {
    "drizzle:generate": "drizzle-kit generate",
    "drizzle:check":    "drizzle-kit check",
    "db:migrate":       "tsx src/migrate.ts",
    "db:reset":         "tsx bin/reset.ts && npm run db:migrate",
    "test":             "vitest run"
  },
  "dependencies": {
    "drizzle-orm": "^0.36.0",
    "pg": "^8.20.0"
  },
  "devDependencies": {
    "@types/pg": "^8.20.0",
    "drizzle-kit": "^0.28.0",
    "tsx": "^4.21.0",
    "typescript": "~5.6.0",
    "vitest": "^2.1.0",
    "@testcontainers/postgresql": "^10.13.0",
    "testcontainers": "^10.13.0"
  }
}
```

`libs/db-kit/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"],
    "lib": ["ES2022"],
    "noEmit": true,
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "emitDeclarationOnly": false,
    "noEmitOnError": false,
    "noUnusedLocals": false
  },
  "include": ["src/**/*", "test/**/*", "bin/**/*", "drizzle.config.ts"]
}
```

> **Why all the overrides?** `tsconfig.base.json` is tuned for Nx's TS Project References (`composite: true`, `emitDeclarationOnly: true`, `declarationMap: true`, `noUnusedLocals: true`). For a library we run with `tsx` and only typecheck (no emit), we turn those off. The `types: ["node"]` line is what fixes `Cannot find name 'process'`.

Install everything from the repo root:

```sh
cd ../../
npm install
```

---

## 2. Drizzle schema files

`libs/db-kit/src/schema/enums.ts`:

```ts
import { pgEnum } from 'drizzle-orm/pg-core';

export const workspaceRole = pgEnum('workspace_role', ['owner', 'admin', 'member', 'viewer']);
```

`libs/db-kit/src/schema/users.ts`:

```ts
import { pgTable, uuid, text, timestamp, boolean } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id:                  uuid('id').defaultRandom().primaryKey(),
  externalId:          text('external_id').notNull().unique(),
  email:               text('email').notNull().unique(),
  displayName:         text('display_name'),
  avatarUrl:           text('avatar_url'),
  deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
  legalHold:           boolean('legal_hold').notNull().default(false),
  createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

`libs/db-kit/src/schema/workspaces.ts`:

```ts
import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users';

export const workspaces = pgTable('workspaces', {
  id:          uuid('id').defaultRandom().primaryKey(),
  slug:        text('slug').notNull().unique(),
  name:        text('name').notNull(),
  ownerId:     uuid('owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  settings:    jsonb('settings').notNull().default({}),
  dataRegion:  text('data_region'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

`libs/db-kit/src/schema/workspace-members.ts`:

```ts
import { pgTable, uuid, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users';
import { workspaces } from './workspaces';
import { workspaceRole } from './enums';

export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId:      uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role:        workspaceRole('role').notNull(),
  joinedAt:    timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
}));
```

`libs/db-kit/src/schema/invitations.ts`:

```ts
import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { workspaces } from './workspaces';
import { workspaceRole } from './enums';

export const invitations = pgTable('invitations', {
  id:           uuid('id').defaultRandom().primaryKey(),
  workspaceId:  uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  email:        text('email').notNull(),
  role:         workspaceRole('role').notNull(),
  tokenHash:    text('token_hash').notNull(),
  invitedBy:    uuid('invited_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  expiresAt:    timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt:   timestamp('accepted_at', { withTimezone: true }),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  oneOpenPerEmail: uniqueIndex('invitations_workspace_email_open')
    .on(t.workspaceId, sql`lower(${t.email})`)
    .where(sql`${t.acceptedAt} IS NULL`),
}));
```

`libs/db-kit/src/schema/index.ts`:

```ts
export * from './enums';
export * from './users';
export * from './workspaces';
export * from './workspace-members';
export * from './invitations';
```

`libs/db-kit/src/relations.ts`:

```ts
import { relations } from 'drizzle-orm';
import { users, workspaces, workspaceMembers, invitations } from './schema';

export const usersRelations = relations(users, ({ many }) => ({
  memberships:    many(workspaceMembers),
  invitationsSent: many(invitations, { relationName: 'invitedBy' }),
  ownedWorkspaces: many(workspaces),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  owner:       one(users, { fields: [workspaces.ownerId], references: [users.id] }),
  members:     many(workspaceMembers),
  invitations: many(invitations),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  user:      one(users,      { fields: [workspaceMembers.userId],      references: [users.id] }),
  workspace: one(workspaces, { fields: [workspaceMembers.workspaceId], references: [workspaces.id] }),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  workspace: one(workspaces, { fields: [invitations.workspaceId], references: [workspaces.id] }),
  invitedBy: one(users,      { fields: [invitations.invitedBy],   references: [users.id], relationName: 'invitedBy' }),
}));
```

---

## 3. Drizzle Kit config

`libs/db-kit/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema:  './src/schema/index.ts',
  out:     './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://syncra:syncra@localhost:5435/syncra',
  },
  verbose: true,
  strict:  true,
});
```

> Migrations talk to Postgres on **5435 (direct)**, not 6432 (PgBouncer). PgBouncer in transaction mode rejects multi-statement migration scripts.

Generate the first migration:

```sh
npm run drizzle:generate -w @syncra/db-kit
ls libs/db-kit/migrations
# 0000_<random_name>.sql  _meta/  meta_journal.json
```

---

## 4. Hand-written SQL migrations

`libs/db-kit/migrations/sql/100_role_grants.sql`:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOINHERIT NOBYPASSRLS LOGIN PASSWORD 'app_user';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO app_user;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO app_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT                  ON SEQUENCES TO app_user;
```

> **Important**: every policy uses `NULLIF(current_setting('app.workspace_id', true), '')::uuid`.
> When the GUC is unset, `current_setting('name', true)` returns `''` (empty string), and `''::uuid` raises a syntax error. `NULLIF(..., '')` converts that empty string to NULL, the comparison becomes `column = NULL` which is `false`, and the policy returns 0 rows — exactly what we want.

`libs/db-kit/migrations/sql/101_rls_workspaces.sql`:

```sql
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspaces_isolation ON workspaces;
CREATE POLICY workspaces_isolation ON workspaces
  FOR ALL
  TO app_user
  USING      (id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
```

`libs/db-kit/migrations/sql/102_rls_workspace_members.sql`:

```sql
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_members_isolation ON workspace_members;
CREATE POLICY workspace_members_isolation ON workspace_members
  FOR ALL
  TO app_user
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
```

`libs/db-kit/migrations/sql/103_rls_invitations.sql`:

```sql
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invitations_isolation ON invitations;
CREATE POLICY invitations_isolation ON invitations
  FOR ALL
  TO app_user
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
```

---

## 5. DB client

`libs/db-kit/src/client.ts`:

```ts
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import * as relations from './relations';

const SUPER_URL = process.env.DATABASE_URL ?? 'postgresql://syncra:syncra@localhost:6432/syncra';
const APP_URL   = process.env.APP_DATABASE_URL ?? 'postgresql://app_user:app_user@localhost:6432/syncra';

export function makePool(url: string) {
  return new Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
}

export const superPool = makePool(SUPER_URL);
export const appPool   = makePool(APP_URL);

export const db    = drizzle(superPool, { schema: { ...schema, ...relations } });
export const appDb = drizzle(appPool,   { schema: { ...schema, ...relations } });

export { schema, relations };
```

---

## 6. `withCtx`

`libs/db-kit/src/with-ctx.ts`:

```ts
import { sql } from 'drizzle-orm';
import { appDb } from './client';

export type Ctx = { workspaceId: string; userId: string };

export async function withCtx<T>(
  ctx: Ctx,
  fn: (tx: Parameters<Parameters<typeof appDb.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return appDb.transaction(async (tx) => {
    // set_config(name, value, is_local) — `true` = SET LOCAL semantics.
    // We use this instead of `SET LOCAL` because Postgres rejects bound
    // parameters in `SET`; set_config() accepts them, keeping values bind-safe.
    await tx.execute(sql`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`);
    await tx.execute(sql`SELECT set_config('app.user_id',      ${ctx.userId},      true)`);
    return fn(tx);
  });
}
```

> **Why not `SET LOCAL`?** `SET LOCAL app.workspace_id = ${id}` looks identical in template form, but Postgres treats `SET` as a utility command that **does not accept bound parameters** — you'll get `syntax error at or near "$1"`. The `set_config(name, value, is_local)` function is the parameterised equivalent. Same effect, safer code.

---

## 7. Public API barrel

`libs/db-kit/src/index.ts`:

```ts
export * from './client';
export * from './with-ctx';
export * as schema from './schema';
```

---

## 8. Migration runner

`libs/db-kit/src/migrate.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');
const SQL_DIR        = join(MIGRATIONS_DIR, 'sql');
const SUPER_URL      = process.env.DATABASE_URL ?? 'postgresql://syncra:syncra@localhost:5435/syncra';

async function listMigrations(): Promise<string[]> {
  const drizzleFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).map((f) => `__drizzle__/${f}`);
  let handFiles: string[] = [];
  try {
    handFiles = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).map((f) => `sql/${f}`);
  } catch {}
  return [...drizzleFiles.sort(), ...handFiles.sort()];
}

async function readSql(rel: string): Promise<string> {
  const path = rel.startsWith('__drizzle__/')
    ? join(MIGRATIONS_DIR, rel.replace('__drizzle__/', ''))
    : join(MIGRATIONS_DIR, rel);
  return readFile(path, 'utf8');
}

async function main() {
  const client = new Client({ connectionString: SUPER_URL });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS _drizzle_migrations (
      id        serial PRIMARY KEY,
      hash      text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const { rows: applied } = await client.query<{ hash: string }>(`SELECT hash FROM _drizzle_migrations`);
  const appliedSet = new Set(applied.map((r) => r.hash));

  const all = await listMigrations();
  for (const rel of all) {
    if (appliedSet.has(rel)) {
      console.log(`skip   ${rel}`);
      continue;
    }
    const sqlText = await readSql(rel);
    console.log(`apply  ${rel}`);
    try {
      await client.query('BEGIN');
      await client.query(sqlText);
      await client.query(`INSERT INTO _drizzle_migrations(hash) VALUES ($1)`, [rel]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`FAIL  ${rel}`);
      throw e;
    }
  }

  await client.end();
  console.log('migrations: done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

`libs/db-kit/bin/reset.ts`:

```ts
import { Client } from 'pg';

const SUPER_URL = process.env.DATABASE_URL ?? 'postgresql://syncra:syncra@localhost:5435/syncra';

const c = new Client({ connectionString: SUPER_URL });
await c.connect();
await c.query(`
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
  GRANT ALL ON SCHEMA public TO syncra;
  GRANT ALL ON SCHEMA public TO public;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS vector;
`);
await c.end();
console.log('schema reset');
```

---

## 9. Run it

```sh
npm run db:reset -w @syncra/db-kit
npm run db:migrate -w @syncra/db-kit
npm run db:migrate -w @syncra/db-kit          # second run prints all "skip"
```

Verify schema and policies:

```sh
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c '\dt'
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c '\d+ workspaces'
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c \
  "SELECT polname, polrelid::regclass AS table FROM pg_policy ORDER BY 2;"
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c \
  "SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('syncra','app_user');"
```

Expected:
- 4 tables: `users`, `workspaces`, `workspace_members`, `invitations`.
- 3 policies, one per workspace-scoped table.
- `app_user` row: `rolbypassrls = f`, `rolcanlogin = t`.

Cross-tenant probe by hand:

```sh
# Insert two workspaces as superuser
psql 'postgresql://syncra:syncra@localhost:6432/syncra' <<'SQL'
INSERT INTO users (external_id, email) VALUES ('idp_u1', 'u1@example.com'), ('idp_u2', 'u2@example.com');
INSERT INTO workspaces (slug, name, owner_id)
SELECT 'a', 'A', id FROM users WHERE email = 'u1@example.com';
INSERT INTO workspaces (slug, name, owner_id)
SELECT 'b', 'B', id FROM users WHERE email = 'u2@example.com';
SELECT id, slug FROM workspaces;
SQL

# As app_user with NO context — must return 0 rows
psql 'postgresql://app_user:app_user@localhost:6432/syncra' \
  -c "SELECT * FROM workspaces;"

# As app_user scoped to workspace A — must return 1 row (A only)
WS_A=$(psql -t -A 'postgresql://syncra:syncra@localhost:6432/syncra' -c "SELECT id FROM workspaces WHERE slug='a';")
psql 'postgresql://app_user:app_user@localhost:6432/syncra' <<SQL
BEGIN;
SET LOCAL app.workspace_id = '$WS_A';
SELECT slug FROM workspaces;
COMMIT;
SQL
```

---

## 10. Testcontainers integration test

### 10.1 Pre-pull the images (one-time)

Testcontainers needs two Docker images. Pre-pull them so the first test run doesn't hit Docker Hub mid-test (which can time out):

```sh
docker pull ankane/pgvector:latest
docker pull testcontainers/ryuk:0.11.0    # used by Testcontainers' auto-cleanup
```

`libs/db-kit/test/setup.ts`:

```ts
// Ryuk is the Testcontainers cleanup helper. We disable it here because:
//  (a) we manually stop the container in afterAll via shutdown(), and
//  (b) pulling testcontainers/ryuk on every CI run hits Docker Hub and can
//      time out, masking the real failure.
process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/schema';
import * as relations from '../src/relations';

export type TestDb = {
  container: StartedPostgreSqlContainer;
  superUrl:  string;
  appUrl:    string;
  superPool: Pool;
  appPool:   Pool;
  superDb:   ReturnType<typeof drizzle<typeof schema & typeof relations>>;
  appDb:     ReturnType<typeof drizzle<typeof schema & typeof relations>>;
  shutdown:  () => Promise<void>;
};

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('ankane/pgvector:latest')
    .withDatabase('syncra')
    .withUsername('syncra')
    .withPassword('syncra')
    .start();

  const superUrl = container.getConnectionUri();
  execSync('npm run db:migrate', {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATABASE_URL: superUrl },
    stdio: 'inherit',
  });

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const appUrl = `postgresql://app_user:app_user@${host}:${port}/syncra`;

  const superPool = new Pool({ connectionString: superUrl });
  const appPool   = new Pool({ connectionString: appUrl });

  const superDb = drizzle(superPool, { schema: { ...schema, ...relations } });
  const appDb   = drizzle(appPool,   { schema: { ...schema, ...relations } });

  // IMPORTANT: drain pools BEFORE stopping the container — otherwise pg pool's
  // open connections will throw "terminating connection due to administrator
  // command" (Postgres error 57P01) when the container goes down mid-query.
  const shutdown = async () => {
    await Promise.allSettled([appPool.end(), superPool.end()]);
    await container.stop();
  };

  return { container, superUrl, appUrl, superPool, appPool, superDb, appDb, shutdown };
}
```

`libs/db-kit/test/rls.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestDb, type TestDb } from './setup';
import { users, workspaces, workspaceMembers } from '../src/schema';

// Definite-assignment assertion: env is set in beforeAll. afterAll defends
// against the case where beforeAll itself failed (so env is undefined),
// which would otherwise throw and hide the real beforeAll error.
let env!: TestDb;

beforeAll(async () => { env = await startTestDb(); }, 180_000);
afterAll(async () => {
  const maybe = env as TestDb | undefined;
  if (maybe) await maybe.shutdown();
});

describe('RLS', () => {
  it('runtime role cannot read another workspace', async () => {
    const [u1] = await env.superDb.insert(users)
      .values({ externalId: 'idp_u1', email: 'u1@example.com' }).returning();
    const [u2] = await env.superDb.insert(users)
      .values({ externalId: 'idp_u2', email: 'u2@example.com' }).returning();

    const [wsA] = await env.superDb.insert(workspaces)
      .values({ slug: 'a', name: 'A', ownerId: u1.id }).returning();
    const [wsB] = await env.superDb.insert(workspaces)
      .values({ slug: 'b', name: 'B', ownerId: u2.id }).returning();

    await env.superDb.insert(workspaceMembers).values([
      { workspaceId: wsA.id, userId: u1.id, role: 'owner' },
      { workspaceId: wsB.id, userId: u2.id, role: 'owner' },
    ]);

    const visible = await env.appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id', ${wsA.id}, true)`);
      return tx.select().from(workspaces);
    });

    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe(wsA.id);
  });

  it('runtime role with NO context sees zero rows', async () => {
    const visible = await env.appDb.select().from(workspaces);
    expect(visible).toHaveLength(0);
  });

  it('runtime role cannot INSERT into another workspace', async () => {
    const [u3] = await env.superDb.insert(users)
      .values({ externalId: 'idp_u3', email: 'u3@example.com' }).returning();
    const [wsC] = await env.superDb.insert(workspaces)
      .values({ slug: 'c', name: 'C', ownerId: u3.id }).returning();
    const [wsD] = await env.superDb.insert(workspaces)
      .values({ slug: 'd', name: 'D', ownerId: u3.id }).returning();

    await expect(env.appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id', ${wsC.id}, true)`);
      await tx.insert(workspaceMembers).values({
        workspaceId: wsD.id, userId: u3.id, role: 'admin',
      });
    })).rejects.toThrow(/row.+violates.+row-level security/i);
  });
});
```

`libs/db-kit/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include:    ['test/**/*.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
```

Run:

```sh
npm test -w @syncra/db-kit
```

Expected: 3 passing tests.

---

## 11. Wire root scripts (optional convenience)

In repo-root `package.json` add:

```jsonc
{
  "scripts": {
    "db:migrate": "npm run db:migrate", -w @syncra/db-kit
    "db:reset":   "npm run db:reset", -w @syncra/db-kit
    "db:test":    "npm test -w @syncra/db-kit"
  }
}
```

Add to `Makefile`:

```makefile
migrate:
	npm run db:migrate

db-reset:
	npm run db:reset
```

(TAB-indented — same warning as Day 1.)

---

## 12. ADR 0001

```sh
mkdir -p docs/adr
```

`docs/adr/0001-drizzle-over-prisma-and-typeorm.md`:

```markdown
---
status: accepted
date: 2026-05-03
deciders: imon
---

# 0001 — Drizzle ORM over Prisma / TypeORM

## Context and Problem Statement

The application needs an ORM that does not get in the way of:
- raw SQL for RLS policies, triggers, partition DDL, vector indexes
- `SET LOCAL` per request to drive RLS
- migrations that mix tool-generated diffs with hand-written SQL files
- PgBouncer transaction-mode pooling

## Considered Options

- Prisma 5
- TypeORM 0.3.x
- Drizzle ORM 0.36+ + Drizzle Kit
- Sequelize

## Decision Outcome

Chosen: **Drizzle ORM**.

- Plain TypeScript schema; no DSL.
- `sql\`...\`` template tag with bound parameters for arbitrary SQL.
- Migrations are plain `.sql` files — we extend the runner to apply our own RLS/role files in the same step.
- No external query engine; a single dependency tree on the Node side.

## Consequences

- We hand-write RLS, triggers, partitions, role grants. They live in `libs/db-kit/migrations/sql/` and are tracked in `_drizzle_migrations`.
- Less batteries-included than Prisma — no Studio, no auto-generated REST.
- Type ergonomics are very good but not Prisma-grade for deeply nested includes; relational queries are explicit.
```

---

## 13. Done-criteria checklist

```sh
npm run drizzle:check -w @syncra/db-kit                                            # schema/migration in sync
npm run db:reset -w @syncra/db-kit && npm run db:migrate -w @syncra/db-kit            # clean apply
npm run db:migrate -w @syncra/db-kit                                               # idempotent: all "skip"
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c '\dt'                # 5 tables (4 + _drizzle_migrations)
psql 'postgresql://syncra:syncra@localhost:6432/syncra' \
  -c "SELECT count(*) FROM pg_policy;"                                          # 3
psql 'postgresql://app_user:app_user@localhost:6432/syncra' \
  -c "SELECT count(*) FROM workspaces;"                                         # 0  (no app.workspace_id)
npm test -w @syncra/db-kit                                                     # 3 passing
test -f docs/adr/0001-drizzle-over-prisma-and-typeorm.md && echo OK            # ADR present
```

---

## 14. Common errors and fixes

| Symptom                                                                              | Cause                                                                                         | Fix                                                                                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Cannot find module 'drizzle-orm/pg-core'` in IDE                                    | `libs/*` not in the root `package.json` `workspaces` array, so deps never installed             | Add `"libs/*"` to the root `package.json` `workspaces` field; run `npm install` from the repo root                          |
| `Cannot find module '@drizzle-orm/pg-core'`                                          | Typo: leading `@` (it's `drizzle-orm/pg-core`, no scope)                                       | Search-and-replace `@drizzle-orm` → `drizzle-orm` across the lib                                                              |
| `Cannot find name 'process'`                                                          | tsconfig didn't include `@types/node`                                                         | Add `"types": ["node"]` to `libs/db-kit/tsconfig.json`                                                                       |
| Migration fails with `syntax error at or near "sql"` or `"```"`                       | Markdown code-fence (` ```sql ` / ` ``` `) accidentally pasted into the `.sql` file            | Open the file, delete the fence lines (first and/or last), save                                                              |
| `cannot insert multiple commands into a prepared statement`                          | Pointed `DATABASE_URL` at PgBouncer (6432) for migrations                                      | Use the **direct** port `5435` for `db:migrate`                                                                              |
| `extension "vector" is not available`                                                 | Forgot Day-1 `01-extensions.sql` ran                                                          | Re-run `make down -v` then `make up`; verify with `\dx`                                                                      |
| `permission denied for table workspaces` from `app_user`                             | `ALTER DEFAULT PRIVILEGES` happened *before* the table was created                             | Re-run `100_role_grants.sql`, or grant explicitly on the new table                                                            |
| Test passes when it should fail (`workspaces` returns rows from B)                   | `app_user` has `BYPASSRLS`, or the test is using `superDb` by mistake                          | `SELECT rolbypassrls FROM pg_roles WHERE rolname='app_user'` — must be `f`                                                  |
| `syntax error at or near "$1"` when calling `SET LOCAL`                              | Postgres rejects bound parameters for `SET` (utility command)                                 | Use `SELECT set_config('app.workspace_id', ${id}, true)` instead — same semantics, accepts parameters                       |
| `invalid input syntax for type uuid: ""`                                              | `current_setting('app.workspace_id', true)` returned `''` (unset GUC) — `''::uuid` errors      | Wrap with `NULLIF(current_setting(...), '')::uuid` so unset becomes NULL → policy returns false → 0 rows                     |
| `(HTTP code 500) ... testcontainers/ryuk` Docker Hub timeout                         | First test run hits Docker Hub for the cleanup helper image                                    | Pre-pull: `docker pull testcontainers/ryuk:0.11.0` and `docker pull ankane/pgvector:latest`. Disable via `TESTCONTAINERS_RYUK_DISABLED=true` |
| `Cannot read properties of undefined (reading 'container')` in `afterAll`            | `beforeAll` threw → `env` is undefined → `afterAll` masks the real error                       | Definite-assignment `let env!: TestDb;` + defensive `if (maybe) await maybe.shutdown()`                                       |
| `terminating connection due to administrator command` (code `57P01`) at end of tests | Container stopped while pg `Pool` still had open connections                                  | Drain pools FIRST: `await Promise.allSettled([appPool.end(), superPool.end()])` then `await container.stop()`                |
| `current_setting('app.workspace_id') -> ERROR: unrecognized configuration parameter` | Missing the second arg `, true`                                                              | All policies use `current_setting('app.workspace_id', true)`                                                                  |
| Drizzle Kit prompts about renames                                                    | Two columns look similar; it asks if you renamed                                              | Pick **create new** unless you actually renamed                                                                              |
| `permission denied for sequence` on insert                                  | New sequence not granted                                              | `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user` (already in 100) |

---

## 15. Tear down (test only)

```sh
npm run db:reset -w @syncra/db-kit      # wipes the public schema and re-applies
make down                            # stops every Day-1 container; volumes preserved
make down -v                         # DESTRUCTIVE: also wipes pgdata
```
