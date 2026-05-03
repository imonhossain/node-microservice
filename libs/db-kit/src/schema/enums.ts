import { pgEnum } from 'drizzle-orm/pg-core';

export const workspaceRole = pgEnum('workspace_role', [
  'owner',
  'admin',
  'member',
  'viewer',
]);
