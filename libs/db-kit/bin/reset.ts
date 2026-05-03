import { Client } from 'pg';

const SUPER_URL =
  process.env.DATABASE_URL ??
  'postgresql://syncra:syncra@localhost:5435/syncra';

const c = new Client({ connectionString: SUPER_URL });
await c.connect();
await c.query(`
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
  GRANT ALL ON SCHEMA public TO syncra;
  GRANT ALL ON SCHEMA public TO public;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS vector;
`);
await c.end();
console.log('schema reset');
