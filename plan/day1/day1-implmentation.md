# Day 1 — Implementation

## 1. Runtime: Node 24 + pnpm 10 via Corepack

```sh
nvm install 24
nvm use 24
echo "24" > .nvmrc

corepack enable
corepack prepare pnpm@10.33.0 --activate

# If migrating from npm:
pnpm import          # reads package-lock.json -> pnpm-lock.yaml
rm -rf node_modules package-lock.json
pnpm install
```

`package.json`:

```jsonc
{
  "packageManager": "pnpm@10.33.0",
  "engines": {
    "node": ">=24.0.0",
    "pnpm": ">=10.0.0"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### Verify

```sh
node --version          # v24.x
pnpm --version          # 10.33.0
cat .nvmrc              # 24
ls pnpm-workspace.yaml pnpm-lock.yaml
pnpm install            # clean run, no errors
pnpm nx --version
```

---

## 2. Directory layout

```sh
mkdir -p infra/otel infra/prometheus infra/tempo \
         infra/grafana/provisioning/datasources \
         infra/grafana/provisioning/dashboards \
         infra/pg-init \
         scripts
```

---

## 3. `docker-compose.yml`

Replace the existing `docker-compose.yml` with:

```yaml
services:
  postgres:
    image: ankane/pgvector:latest
    ports: ['5435:5432']
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./infra/pg-init:/docker-entrypoint-initdb.d
    environment:
      POSTGRES_USER: syncra
      POSTGRES_PASSWORD: syncra
      POSTGRES_DB: syncra
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U syncra -d syncra']
      interval: 5s
      timeout: 3s
      retries: 10

  pgbouncer:
    image: edoburu/pgbouncer:latest
    ports: ['6432:6432']
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_USER: syncra
      DB_PASSWORD: syncra
      DB_NAME: syncra
      LISTEN_PORT: 6432
      POOL_MODE: transaction
      AUTH_TYPE: scram-sha-256
      ADMIN_USERS: syncra
    depends_on:
      postgres:
        condition: service_healthy

  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s

  nats:
    image: nats:2-alpine
    command: ['-js', '-m', '8222']
    ports: ['4222:4222', '8222:8222']

  meilisearch:
    image: getmeili/meilisearch:v1.13
    ports: ['7700:7700']
    environment:
      MEILI_MASTER_KEY: dev-master-key
      MEILI_ENV: development

  temporal:
    image: temporalio/auto-setup:1.25
    environment:
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: syncra
      POSTGRES_PWD: syncra
      POSTGRES_SEEDS: postgres
    depends_on:
      postgres:
        condition: service_healthy

  temporal-ui:
    image: temporalio/ui:2.30.0
    environment:
      TEMPORAL_ADDRESS: temporal:7233
      TEMPORAL_CORS_ORIGINS: http://localhost:3000
    ports: ['8080:8080']
    depends_on: [temporal]

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports: ['9200:9000', '9201:9001']
    environment:
      MINIO_ROOT_USER: syncra
      MINIO_ROOT_PASSWORD: syncra-secret
    volumes:
      - minio:/data

  mailpit:
    image: axllent/mailpit:latest
    ports: ['1025:1025', '8025:8025']

  unleash-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: unleash
      POSTGRES_PASSWORD: unleash
      POSTGRES_DB: unleash
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U unleash -d unleash']
      interval: 5s

  unleash:
    image: unleashorg/unleash-server:latest
    ports: ['4242:4242']
    environment:
      DATABASE_URL: 'postgres://unleash:unleash@unleash-db:5432/unleash'
      DATABASE_SSL: 'false'
    depends_on:
      unleash-db:
        condition: service_healthy

  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    command: ['--config=/etc/otelcol-contrib/config.yaml']
    volumes:
      - ./infra/otel/config.yaml:/etc/otelcol-contrib/config.yaml
    ports: ['4317:4317', '4318:4318']

  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./infra/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml
    ports: ['9090:9090']

  loki:
    image: grafana/loki:latest
    command: ['-config.file=/etc/loki/local-config.yaml']
    ports: ['3100:3100']

  tempo:
    image: grafana/tempo:2.6.0   # pinned: latest (2.9.x) drops `ingester`/`compactor` top-level fields
    command: ['-config.file=/etc/tempo.yaml']
    volumes:
      - ./infra/tempo/tempo.yaml:/etc/tempo.yaml
    ports: ['3200:3200']

  grafana:
    image: grafana/grafana:latest
    ports: ['3030:3000']
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: 'true'
      GF_AUTH_ANONYMOUS_ORG_ROLE: Admin
      GF_AUTH_DISABLE_LOGIN_FORM: 'true'
    volumes:
      - ./infra/grafana/provisioning:/etc/grafana/provisioning
    depends_on: [prometheus, loki, tempo]

volumes:
  pgdata:
  minio:
```

---

## 4. Postgres init script

`infra/pg-init/01-extensions.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

> `pg_partman` is not included in `ankane/pgvector`. Day 10 will switch to a custom image that adds it. Today: just verify `vector` loads.

---

## 5. OTel Collector config

`infra/otel/config.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch: {}

exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
  otlphttp/loki:
    endpoint: http://loki:3100/otlp
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  debug:
    verbosity: basic

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus, debug]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/loki, debug]
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/tempo, debug]
```

---

## 6. Prometheus config

`infra/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ['localhost:9090']

  - job_name: otel-collector
    static_configs:
      - targets: ['otel-collector:8889']
```

---

## 7. Tempo config

`infra/tempo/tempo.yaml`:

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318

ingester:
  max_block_duration: 5m

compactor:
  compaction:
    block_retention: 1h

storage:
  trace:
    backend: local
    wal:
      path: /var/tempo/wal
    local:
      path: /var/tempo/blocks
```

---

## 8. Grafana datasources

`infra/grafana/provisioning/datasources/datasources.yaml`:

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true

  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100

  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
```

`infra/grafana/provisioning/dashboards/dashboards.yaml`:

```yaml
apiVersion: 1

providers:
  - name: default
    orgId: 1
    folder: ''
    type: file
    options:
      path: /etc/grafana/provisioning/dashboards
```

---

## 9. Makefile

`Makefile` (use **TABS** for indentation, not spaces):

```makefile
.PHONY: up down logs ps restart check psql nats-sub

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps

restart:
	docker compose restart

check:
	pnpm tsx scripts/check-infra.ts

psql:
	psql 'postgresql://syncra:syncra@localhost:6432/syncra'

nats-sub:
	docker compose exec nats nats sub ">"
```

---

## 10. Smoke-test script

Install runtime deps at the workspace root (`-w` flag is required in a pnpm workspace):

```sh
pnpm add -Dw tsx @types/pg
pnpm add  -w pg ioredis nats
```

`scripts/check-infra.ts`:

```ts
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
```

> Wrap the loop in `main()` — `tsx` transpiles to CJS by default, which doesn't allow top-level `await`.

---

## 11. Boot + verify

```sh
make up
docker compose ps           # all services -> Up / Up (healthy)

# Wait ~30s on cold start (Temporal schema setup, Unleash migrations)
sleep 30

make check                  # every line should be green
```

Expected `make check` output (17 OKs):

```
OK   postgres (direct 5435)
OK   postgres extensions
OK   pgbouncer (6432)
OK   redis (6379)
OK   nats jetstream (4222)
OK   nats monitoring (8222)
OK   meilisearch (7700)
OK   temporal ui (8080)
OK   minio (9200)
OK   mailpit ui (8025)
OK   unleash (4242)
OK   prometheus (9090)
OK   loki (3100)
OK   tempo (3200)
OK   grafana (3030)
OK   otel grpc (4317)
OK   otel http (4318)
```

### 11.1 Common boot failures and fixes

| Symptom                                                              | Cause                                                              | Fix                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `zsh: command not found: logs:` when typing Makefile contents        | Pasting recipe lines into shell instead of saving to `Makefile`    | Save to `Makefile` (capital M, no extension), TAB-indented; run `make up` |
| `WARN Unsupported engine: wanted: {"node":">=24.0.0"}`               | Shell still on Node 22                                             | `nvm install 24 && nvm use 24`                                       |
| `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "tsx" not found`         | tsx missing                                                        | `pnpm add -Dw tsx @types/pg`                                         |
| `zsh: command not found: psql`                                       | host has no Postgres client                                        | `brew install libpq && brew link --force libpq`, **or** use container: `docker compose exec postgres psql -U syncra -d syncra` |
| `service "nats" is not running`                                      | stack never booted                                                 | `make up` first                                                      |
| Tempo container `Exited (1)` with `field ingester not found`         | `grafana/tempo:latest` (≥2.9) renamed/removed top-level fields     | Pin `image: grafana/tempo:2.6.0` in compose                          |
| PgBouncer `read ECONNRESET` from host on 6432                        | Default `LISTEN_PORT=5432` inside container; host maps `6432:6432` | Set `LISTEN_PORT: 6432` in pgbouncer env                             |
| Loki `/ready -> 503` for ~30s after boot                             | Loki ingester delays readiness on cold start                       | Re-run `make check` after another 15-30s                             |
| `Top-level await is currently not supported with the "cjs" output`   | tsx defaults to CJS                                                | Wrap the loop in `async function main(){...}; main();`               |

---

## 12. End-to-end sanity probes

### 12.1 Postgres via PgBouncer

```sh
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c 'SELECT 1'
psql 'postgresql://syncra:syncra@localhost:6432/syncra' \
  -c "SELECT extname FROM pg_extension WHERE extname = 'vector'"
```

### 12.2 Redis

```sh
docker compose exec redis redis-cli ping        # -> PONG
docker compose exec redis redis-cli set k v
docker compose exec redis redis-cli get k       # -> v
```

### 12.3 NATS JetStream pub/sub

Terminal A:

```sh
docker compose exec nats nats sub ">"
```

Terminal B:

```sh
docker compose exec nats nats pub task.created '{"id":"t_1","title":"hello"}'
```

Terminal A should print the message. Stop with `Ctrl+C`.

Stream creation + replay:

```sh
docker compose exec nats nats stream add TASKS \
  --subjects 'task.>' --storage file --retention limits \
  --max-msgs=-1 --max-bytes=-1 --max-age=24h \
  --discard old --dupe-window 2m --replicas 1 --defaults
docker compose exec nats nats stream ls
docker compose exec nats nats stream info TASKS
```

### 12.4 Meilisearch

```sh
curl -s http://localhost:7700/health
# {"status":"available"}

curl -s -H "Authorization: Bearer dev-master-key" \
  http://localhost:7700/version
```

### 12.5 MinIO + create a bucket

```sh
docker run --rm --network syncra_default \
  -e MC_HOST_local=http://syncra:syncra-secret@minio:9000 \
  minio/mc mb local/syncra-dev
docker run --rm --network syncra_default \
  -e MC_HOST_local=http://syncra:syncra-secret@minio:9000 \
  minio/mc ls local/
```

> Replace `syncra_default` with the real network name from `docker network ls | grep syncra`.

Console: open http://localhost:9201 (login `syncra` / `syncra-secret`).

### 12.6 Mailpit

```sh
# send a test mail via local smtp
python3 - <<'PY'
import smtplib, email.message
m = email.message.EmailMessage()
m['From'] = 'dev@syncra.local'
m['To']   = 'you@syncra.local'
m['Subject'] = 'Day 1 hello'
m.set_content('it works')
with smtplib.SMTP('localhost', 1025) as s:
    s.send_message(m)
PY
```

Open http://localhost:8025 — the message is there.

### 12.7 Temporal UI

Open http://localhost:8080 — namespace list loads, `default` namespace exists.

### 12.8 Unleash

Open http://localhost:4242 — login `admin` / `unleash4all`.

### 12.9 Grafana datasources

Open http://localhost:3030 → **Connections → Data sources**. Confirm Prometheus, Loki, Tempo are listed and **green** (Save & Test).

### 12.10 OTel pipeline (push a fake metric)

```sh
curl -s -X POST http://localhost:4318/v1/metrics \
  -H 'content-type: application/json' \
  -d '{
    "resourceMetrics":[{"scopeMetrics":[{"metrics":[{
      "name":"day1.smoke","unit":"1",
      "sum":{"aggregationTemporality":1,"isMonotonic":true,
             "dataPoints":[{"asInt":"1","timeUnixNano":"'"$(date +%s%N)"'"}]}
    }]}]}]
  }'
```

Then in Prometheus (`http://localhost:9090`) query `day1_smoke_total` → returns a sample.

---

## 13. Done-criteria checklist

```sh
node --version            # v24.x
pnpm --version            # 10.33.x
cat .nvmrc                # 24
docker compose ps         # all Up / healthy
make check                # all ✔
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c 'SELECT 1'
curl -s http://localhost:8080 -o /dev/null -w "%{http_code}\n"   # 200
curl -s http://localhost:3030/api/health
curl -s http://localhost:7700/health
curl -s http://localhost:4242/health
curl -s http://localhost:9090/-/ready
curl -s http://localhost:3100/ready
curl -s http://localhost:3200/ready
```

---

## 14. Tear down

```sh
make down                 # stop containers, keep volumes
docker compose down -v    # nuke volumes (DESTRUCTIVE — wipes pgdata, minio)
```
