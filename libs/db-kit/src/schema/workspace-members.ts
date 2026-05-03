import { pgTable, uuid, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users';
import { workspaces } from './workspaces';
import { workspaceRole } from './enums';

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
  }),
);
