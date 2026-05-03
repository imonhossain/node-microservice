import net from 'node:net';
import { Client as PgClient } from 'pg';
import { connect as natsConnect } from 'nats';
import Redis from 'ioredis';

function checkTcp(host: string, port: number, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`tcp ${host}:${port} timeout`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function checkHttp(url: string, expectStatusBelow = 500): Promise<void> {
  const res = await fetch(url);
  if (res.status >= expectStatusBelow) {
    throw new Error(`${url} -> ${res.status}`);
  }
}

async function checkPg(connStr: string): Promise<void> {
  const client = new PgClient({ connectionString: connStr });
  await client.connect();
  const r = await client.query('SELECT 1 AS ok');
  await client.end();
  if (r.rows[0].ok !== 1) throw new Error('pg select did not return 1');
}

async function checkPgVector(connStr: string): Promise<void> {
  const client = new PgClient({ connectionString: connStr });
  await client.connect();
  const r = await client.query(
    `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
  );
  await client.end();
  if (r.rowCount !== 1) throw new Error('vector extension not installed');
}

async function checkRedis(host: string, port: number): Promise<void> {
  const r = new Redis({ host, port, lazyConnect: true, maxRetriesPerRequest: 1 });
  await r.connect();
  const pong = await r.ping();
  r.disconnect();
  if (pong !== 'PONG') throw new Error(`redis ping -> ${pong}`);
}

async function checkNats(url: string): Promise<void> {
  const nc = await natsConnect({ servers: url });
  const jsm = await nc.jetstreamManager();
  await jsm.streams.list().next();
  await nc.drain();
}

const checks: Array<[string, () => Promise<void>]> = [
  ['postgres (direct 5435)', () => checkTcp('localhost', 5435)],
  ['postgres extensions',    () => checkPgVector('postgresql://syncra:syncra@localhost:5435/syncra')],
  ['pgbouncer (6432)',       () => checkPg('postgresql://syncra:syncra@localhost:6432/syncra')],
  ['redis (6379)',           () => checkRedis('localhost', 6379)],
  ['nats jetstream (4222)',  () => checkNats('nats://localhost:4222')],
  ['nats monitoring (8222)', () => checkHttp('http://localhost:8222/healthz')],
  ['meilisearch (7700)',     () => checkHttp('http://localhost:7700/health')],
  ['temporal ui (8080)',     () => checkHttp('http://localhost:8080')],
  ['minio (9200)',           () => checkHttp('http://localhost:9200/minio/health/ready')],
  ['mailpit ui (8025)',      () => checkHttp('http://localhost:8025')],
  ['unleash (4242)',         () => checkHttp('http://localhost:4242/health')],
  ['prometheus (9090)',      () => checkHttp('http://localhost:9090/-/ready')],
  ['loki (3100)',            () => checkHttp('http://localhost:3100/ready')],
  ['tempo (3200)',           () => checkHttp('http://localhost:3200/ready')],
  ['grafana (3030)',         () => checkHttp('http://localhost:3030/api/health')],
  ['otel grpc (4317)',       () => checkTcp('localhost', 4317)],
  ['otel http (4318)',       () => checkTcp('localhost', 4318)],
];

async function main() {
  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`OK   ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name} - ${(err as Error).message}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
