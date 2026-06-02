import { sql } from 'drizzle-orm';
import { appDb } from './client.js';

export type Ctx = { workspaceId: string; userId: string };

export async function withCtx<T>(
  ctx: Ctx,
  fn: (
    tx: Parameters<Parameters<typeof appDb.transaction>[0]>[0],
  ) => Promise<T>,
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
