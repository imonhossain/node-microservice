import { newEnforcer, Enforcer } from 'casbin';
import { join } from 'node:path';

let enforcer: Enforcer | null = null;

export async function getEnforcer(): Promise<Enforcer> {
  if (enforcer) return enforcer;
  const dir = join(import.meta.dirname, 'casbin');
  enforcer = await newEnforcer(
    join(dir, 'model.conf'),
    join(dir, 'policy.csv'),
  );
  return enforcer;
}

export async function can(
  role: string,
  workspaceSlug: string,
  action: string,
): Promise<boolean> {
  const e = await getEnforcer();
  return e.enforce(role, `workspace/${workspaceSlug}`, action);
}
