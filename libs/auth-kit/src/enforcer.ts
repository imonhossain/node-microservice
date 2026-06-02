import { Enforcer, Model, StringAdapter, newEnforcer, newModel } from 'casbin';

// Inline the Casbin model and policy as strings so the enforcer doesn't need
// to read files at runtime. This was previously loading from disk via
// `import.meta.dirname` — which breaks once auth-kit is bundled into the
// backend's webpack output (different cwd, different module system).
//
// Keep these in sync with libs/auth-kit/src/casbin/{model.conf,policy.csv} —
// those files are still the source of truth for hand-editing and for tooling
// like the Casbin online editor; the strings below are a build-time mirror.

// Matcher note: the action comparison uses `keyMatch(r.act, p.act)`, not
// literal equality, so a policy line with action `*` matches any concrete
// request action like `member:list`. Without that, the `p, owner, …, *`
// catch-all in policy.csv would never fire.
const MODEL = `
[request_definition]
r = sub, obj, act

[policy_definition]
p = sub, obj, act

[role_definition]
g = _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub) && keyMatch(r.obj, p.obj) && keyMatch(r.act, p.act)
`.trim();

const POLICY = `
p, owner,  workspace/*, *
p, admin,  workspace/*, workspace:read
p, admin,  workspace/*, workspace:rename
p, admin,  workspace/*, workspace:invite
p, admin,  workspace/*, member:list
p, admin,  workspace/*, member:remove
p, member, workspace/*, workspace:read
p, member, workspace/*, member:list
p, viewer, workspace/*, workspace:read
`.trim();

let enforcer: Enforcer | null = null;

export async function getEnforcer(): Promise<Enforcer> {
  if (enforcer) return enforcer;
  const model: Model = newModel(MODEL);
  const adapter = new StringAdapter(POLICY);
  enforcer = await newEnforcer(model, adapter);
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
