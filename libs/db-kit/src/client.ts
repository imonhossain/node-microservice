import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';
import * as relations from './relations.js';

const SUPER_URL =
  process.env.DATABASE_URL ??
  'postgresql://syncra:syncra@localhost:6432/syncra';
const APP_URL =
  process.env.APP_DATABASE_URL ??
  'postgresql://app_user:app_user@localhost:6432/syncra';

export function makePool(url: string) {
  return new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

export const superPool = makePool(SUPER_URL);
export const appPool = makePool(APP_URL);

export const db = drizzle(superPool, { schema: { ...schema, ...relations } });
export const appDb = drizzle(appPool, { schema: { ...schema, ...relations } });
