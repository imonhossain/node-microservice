export * from './client.js';
export * from './with-ctx.js';
export * as schema from './schema/index.js';

// Re-export Drizzle query helpers through db-kit so consumers don't import
// drizzle-orm directly. Importing through one path side-steps the dual-package
// hazard: consumers of db-kit (apps/backend, apps/workers, etc.) may be CJS
// while db-kit itself is ESM. When both sides import `eq` via db-kit, the
// `SQL<unknown>` type comes from a single drizzle declaration.
export {
  eq, ne, gt, gte, lt, lte,
  and, or, not,
  isNull, isNotNull,
  inArray, notInArray,
  like, ilike,
  desc, asc,
  sql,
} from 'drizzle-orm';
