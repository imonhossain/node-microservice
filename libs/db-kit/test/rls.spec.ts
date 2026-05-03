import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestDb, type TestDb } from './setup';
import { users, workspaces, workspaceMembers } from '../src/schema';

let env!: TestDb;

beforeAll(async () => {
  env = await startTestDb();
}, 180_000);
afterAll(async () => {
  const maybe = env as TestDb | undefined;
  if (maybe) await maybe.shutdown();
});

describe('RLS', () => {
  it('runtime role cannot read another workspace', async () => {
    const [u1] = await env.superDb
      .insert(users)
      .values({ externalId: 'idp_u1', email: 'u1@example.com' })
      .returning();
    const [u2] = await env.superDb
      .insert(users)
      .values({ externalId: 'idp_u2', email: 'u2@example.com' })
      .returning();

    const [wsA] = await env.superDb
      .insert(workspaces)
      .values({ slug: 'a', name: 'A', ownerId: u1.id })
      .returning();
    const [wsB] = await env.superDb
      .insert(workspaces)
      .values({ slug: 'b', name: 'B', ownerId: u2.id })
      .returning();

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
    const [u3] = await env.superDb
      .insert(users)
      .values({ externalId: 'idp_u3', email: 'u3@example.com' })
      .returning();
    const [wsC] = await env.superDb
      .insert(workspaces)
      .values({ slug: 'c', name: 'C', ownerId: u3.id })
      .returning();
    const [wsD] = await env.superDb
      .insert(workspaces)
      .values({ slug: 'd', name: 'D', ownerId: u3.id })
      .returning();

    await expect(
      env.appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.workspace_id', ${wsC.id}, true)`);
        await tx.insert(workspaceMembers).values({
          workspaceId: wsD.id,
          userId: u3.id,
          role: 'admin',
        });
      }),
    ).rejects.toThrow(/row.+violates.+row-level security/i);
  });
});
