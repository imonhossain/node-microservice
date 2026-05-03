import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users';

export const workspaces = pgTable('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  settings: jsonb('settings').notNull().default({}),
  dataRegion: text('data_region'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
