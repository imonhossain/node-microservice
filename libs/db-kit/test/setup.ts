// Ryuk is the Testcontainers cleanup helper. We disable it for local dev
// because (a) we manually stop the container in afterAll, and (b) pulling
// testcontainers/ryuk on every run hits Docker Hub and can time out.
process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/schema';
import * as relations from '../src/relations';

export type TestDb = {
  container: StartedPostgreSqlContainer;
  superUrl: string;
  appUrl: string;
  superPool: Pool;
  appPool: Pool;
  superDb: ReturnType<typeof drizzle<typeof schema & typeof relations>>;
  appDb: ReturnType<typeof drizzle<typeof schema & typeof relations>>;
  shutdown: () => Promise<void>;
};

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('ankane/pgvector:latest')
    .withDatabase('syncra')
    .withUsername('syncra')
    .withPassword('syncra')
    .start();

  const superUrl = container.getConnectionUri();
  execSync('pnpm db:migrate', {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATABASE_URL: superUrl },
    stdio: 'inherit',
  });

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const appUrl = `postgresql://app_user:app_user@${host}:${port}/syncra`;

  const superPool = new Pool({ connectionString: superUrl });
  const appPool = new Pool({ connectionString: appUrl });

  const superDb = drizzle(superPool, { schema: { ...schema, ...relations } });
  const appDb = drizzle(appPool, { schema: { ...schema, ...relations } });

  const shutdown = async () => {
    // Drain pools BEFORE stopping the container so in-flight connections
    // don't error with "terminating connection due to administrator command".
    await Promise.allSettled([appPool.end(), superPool.end()]);
    await container.stop();
  };

  return {
    container,
    superUrl,
    appUrl,
    superPool,
    appPool,
    superDb,
    appDb,
    shutdown,
  };
}
