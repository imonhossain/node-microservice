import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');
const SQL_DIR = join(MIGRATIONS_DIR, 'sql');
const SUPER_URL =
  process.env.DATABASE_URL ??
  'postgresql://syncra:syncra@localhost:5435/syncra';

async function listMigrations(): Promise<string[]> {
  const drizzleFiles = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => `__drizzle__/${f}`);
  let handFiles: string[] = [];
  try {
    handFiles = (await readdir(SQL_DIR))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => `sql/${f}`);
  } catch {
    /* empty */
  }
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

  const { rows: applied } = await client.query<{ hash: string }>(
    `SELECT hash FROM _drizzle_migrations`,
  );
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
      await client.query(`INSERT INTO _drizzle_migrations(hash) VALUES ($1)`, [
        rel,
      ]);
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
