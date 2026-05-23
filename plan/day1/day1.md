# Day 1 — Infra Bootstrap (Learning Guide)

> Goal of today: a single `make up` brings up every piece of infrastructure Syncra will ever need, running in Docker, and a smoke-test script proves each one is reachable. Along the way you'll learn **why** each tool exists and **what problem it solved that its predecessors couldn't**.
>
> You already know PostgreSQL. Everything else in this doc assumes nothing.

---

## 0. Orientation — why so many containers?

A modern SaaS isn't just "an app talking to Postgres". It's:

```
        ┌─ you (the user) ─┐
        │   browser  +     │
        │   API clients    │
        └────────┬─────────┘
                 │
        ┌────────▼──────────┐
        │   your app code   │  ← one or two Node processes
        └─┬───────┬──────┬──┘
          │       │      │
  ┌───────▼─┐  ┌──▼──┐  ┌▼──────────┐
  │ data    │  │ msg │  │  side     │
  │ stores  │  │ bus │  │  services │
  │ (PG,    │  │(NATS│  │  (search, │
  │  Redis, │  │ JS) │  │   files,  │
  │  CH)    │  │     │  │   email)  │
  └─────────┘  └─────┘  └───────────┘
         │         │         │
         └─────────┴─────────┘
                   │
     ┌─────────────▼─────────────┐
     │ observability plumbing    │
     │ (metrics, logs, traces,   │
     │  dashboards, flags)       │
     └───────────────────────────┘
```

Each "container" we bring up today is a piece of that picture. In production you'd rent these as managed services (RDS, ElastiCache, Confluent, Temporal Cloud, Datadog, etc.). For local dev we run them ourselves — and Docker is what makes "run MinIO on your laptop" feasible.

---

## 1. The runtime — Node 24 + nvm + npm

### What changed

- `.nvmrc` pins Node **24** for this repo.
- The root `package.json` has a `workspaces` array — npm uses that to wire up `apps/*`, `libs/*`, `packages/*`.
- `npm install` at the root installs every workspace at once and writes a single `package-lock.json`.

### Why Node 24

Node's release cadence is: every ~6 months a new major; LTS ones are even-numbered (18, 20, 22, 24). Node 24 is the current active LTS in 2026.

- First-class `fetch`, `AbortController`, Web Streams — no polyfills.
- Native ESM with fewer footguns than Node 18.
- Permission model (`--permission`) — finer-grained than "everything or nothing".
- Test runner (`node:test`) good enough to replace Jest for simple repos.

### Why npm

npm 10 ships inside Node 24. Nothing to install, nothing to bootstrap. The features we need are already there:

- **Speed** — npm 10 is fast enough for a repo of our size. We notice install times in seconds, not minutes.
- **Workspaces** — first-class since npm 7. `npm install`, `npm install -w <pkg>`, and `npm run <script> -w <pkg>` all work cleanly across the monorepo.
- **Lockfile** — `package-lock.json` at the repo root pins every transitive dependency. CI uses `npm ci` for byte-for-byte identical installs.

The one trade-off worth knowing: npm hoists `node_modules`, which means any package can `require` something a sibling declared (a "phantom dependency"). We accept that and add `eslint-plugin-import/no-extraneous-dependencies` later as the guardrail.

### npm workspaces in two lines

Root `package.json`:

```json
{ "workspaces": ["apps/*", "libs/*", "packages/*"] }
```

In an app's `package.json`:

```jsonc
{
  "dependencies": {
    "@syncra/contracts": "*"
  }
}
```

`npm install` at the root symlinks `@syncra/contracts` into the consumer's `node_modules`. Edit `libs/contracts/src/foo.ts` and `apps/api` sees the change immediately — that's the whole point of a workspace.

### Targeting one workspace from the root

```sh
npm install drizzle-orm -w @syncra/db-kit          # add a dep to one workspace
npm install --save-dev tsx -w @syncra/db-kit       # devDep in one workspace
npm test -w @syncra/db-kit                          # run "test" in one workspace
npm run db:migrate -w @syncra/db-kit                # any script
npm exec --workspace=@syncra/db-kit -- tsc --noEmit # run a CLI inside the workspace
```

`-w` is short for `--workspace`. Repeat it (`-w pkg1 -w pkg2`) to target multiple, or use `--workspaces` to mean "all of them".

### Verify

```sh
node --version        # v24.x.x
npm --version         # 10.x.x  (bundled with Node 24)
cat .nvmrc            # 24
ls package.json package-lock.json
```

---

## 2. `docker-compose` — why not plain `docker run`

`docker run redis` works. But you need Redis **and** Postgres **and** NATS **and** 12 more services, all on the same network, with env vars, with dependencies ("start Postgres before the app"), with persistent volumes. Typing a `docker run` for each every morning is absurd.

`docker-compose.yml` is a **declarative** description of your stack. `docker compose up` starts everything; `down` stops it; `logs -f` follows all of them. Networking between containers works by service name: from the `api` container, `postgres:5432` resolves automatically.

You'll see today's file uses:

- `services:` — each service is a container
- `volumes:` — named volumes for persistent state
- `healthcheck:` — Docker will wait for the container to be healthy before `depends_on` starts the next one
- Port mappings like `5435:5432` — host port 5435 → container port 5432 (we use 5435 to avoid clashing with any local Postgres you already run)

---

## 3. Make — the universal task runner

You'll add three targets today:

```makefile
up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f
```

Why Make and not `npm scripts`?

- Scripts in `package.json` are fine for app-related things (`npm run dev`, `npm run build`).
- Infra lives **outside** the app — before the app exists, when the app is broken, when you're debugging the database. You don't want those commands coupled to the JS ecosystem.
- Make has been on every Unix box for 50 years. No setup.
- `make up` is shorter than `npm run docker:up` and signals "this is infra, not app code".

Think of it like: `npm run <thing>` = application; `make <thing>` = everything under the app.

---

## 4. The data layer

### 4.1 PgBouncer — the "too many connections" fix

**The problem.** Node is single-threaded but serves many requests per process. If every request opens a Postgres connection, and you run 4 Node processes, you quickly have hundreds of connections. Postgres assigns each connection a backend process of its own (Postgres is fork-per-connection — this hasn't changed since 1996). At ~500 connections, your Postgres host OOMs, **regardless of how busy those connections actually are**.

Old workarounds — per-process connection pools (e.g. `pg-pool`) help within one process, but not across processes.

**The fix — PgBouncer.** A tiny proxy that sits between your apps and Postgres and pools connections. Apps open cheap, short-lived connections to PgBouncer; PgBouncer multiplexes them over a small pool of actual Postgres connections.

Two modes that matter:
- **Session pooling** — one Postgres connection per client for their entire session. Fine for long-running desktop-style clients; not great for web apps.
- **Transaction pooling** (what we use) — client gets a Postgres connection only for the duration of a single transaction. You can serve 10,000 client connections on 25 real Postgres ones.

Caveats of transaction pooling you'll see later:
- Prepared statements don't survive across transactions unless you use protocol extensions.
- You can't use `SET` without `LOCAL` (that's why our RLS setup uses `SET LOCAL app.workspace_id`).

Our compose maps PgBouncer to host port `6432`; apps connect there, not directly to Postgres.

### 4.2 pgvector — the vector DB that's just Postgres

**The problem.** Semantic search / "find tasks similar to X" needs vector embeddings and a similarity index. Circa 2021 the options were:

- **Pinecone** (hosted, closed source, $$$) — "third database to sync into".
- **Weaviate / Milvus / Qdrant** — open source vector DBs with their own data model, their own API, their own ops.
- DIY with brute-force cosine scans in a column — OK at 1k rows, dies at 1M.

The painful common thread: **your embeddings live in a different database from your source rows**. You get drift, dual-writes, stale indexes, two backup strategies.

**pgvector** is a Postgres extension — just `CREATE EXTENSION vector;`. You get:

```sql
CREATE EXTENSION vector;

ALTER TABLE task_embeddings
  ADD COLUMN embedding vector(1536);

CREATE INDEX ON task_embeddings
  USING hnsw (embedding vector_cosine_ops);

-- queries:
SELECT * FROM task_embeddings
ORDER BY embedding <=> :query_vector
LIMIT 10;
```

Two index types worth knowing:
- **HNSW** (Hierarchical Navigable Small World) — approximate nearest-neighbour; fast, memory-heavy, what we'll use.
- **IVF** — partitions vectors into clusters; smaller, slightly slower, needs retraining.

In Syncra, embeddings live on `task_embeddings` right next to the `tasks` they describe. **Same transactions. Same RLS policies. Same backup.** No dual-write. That simplification is the whole point.

### 4.3 pg_partman — Postgres partitioning without tears

**The problem.** Our `events` table will grow unboundedly — one row per audit event, forever. At 500M rows:

- Autovacuum takes hours.
- Indexes are huge.
- Dropping old data means a slow `DELETE` that generates mountains of dead tuples.
- Backups take forever.

**The fix — partitioning.** Split the table into a partition per month. Queries that filter by `occurred_at` (most of them) scan only the relevant partition(s). Dropping old data = `DROP TABLE events_2024_01` — instant.

Postgres has native partitioning (`PARTITION BY RANGE (occurred_at)`). But you still need to **create next month's partition before the 1st of next month**, and **drop partitions older than N months**. Forgetting either is an incident.

**pg_partman** automates that — a tiny background worker that creates partitions ahead of time and optionally drops old ones based on a retention policy. You run `SELECT partman.run_maintenance()` on a schedule (we'll invoke it from a Temporal workflow in Week 2).

### 4.4 Redis 7 — you know it, but here's specifically what we use it for

You almost certainly know Redis as a cache. In Syncra, it wears four hats:

- **Cache**: hot workspace reads (member lists, role resolution).
- **BullMQ queues**: background jobs that don't need Temporal's durability (email send, thumbnail generation).
- **Rate-limit counters**: token-bucket per API key.
- **Yjs presence fan-out**: the Hocuspocus Redis adapter uses Pub/Sub so multiple realtime instances share awareness state.

One Redis, four roles. We keep them on different DB numbers (`0` cache, `1` BullMQ, etc.) and different connection instances (bulkheading — a stuck BullMQ connection doesn't starve cache reads).

---

## 5. The messaging layer — NATS JetStream

### 5.1 Two problems you face once you have > 1 service

1. **Broadcast**: "task 123 was created" — many downstream consumers care (audit, search, AI, webhooks). HTTP fan-out means the producer knows every consumer — tight coupling.
2. **Durability**: if a consumer is down, the event shouldn't vanish. If a producer is slow, the consumer shouldn't stall.

Before message brokers: "cron jobs scanning tables for changes." This works at prototype scale. Breaks at real scale.

### 5.2 The broker landscape

- **RabbitMQ** (2007) — AMQP, push-based, exchanges and queues. Very flexible. Gets cranky at scale; weird failure modes; exchange/queue/binding model is a lot to hold in your head.
- **Kafka** (2011) — log-based, pull, enormous throughput, battle-tested at LinkedIn/Uber scale. Operationally heavy: ZooKeeper (or KRaft), JVM, topic partition planning, consumer group coordination. Industry-standard **if you already have platform engineers**.
- **NATS** (2014) — text protocol, simple subjects, *incredibly* fast. Original NATS was fire-and-forget: no persistence, no retries.

### 5.3 Why JetStream

Core NATS solves broadcast beautifully but not durability. **JetStream** (2021+) adds:

- **Durable streams** — messages persisted to disk.
- **At-least-once delivery** with acknowledgements.
- **Consumer groups** (multiple instances share the load).
- **Replay from any point** — "reprocess the last 24 hours" is a command, not a migration.
- **Subject-based routing** — `task.*` catches `task.created`, `task.updated`, …

vs. Kafka: NATS JetStream is one Go binary, single-node dev setup is `nats -js`, no JVM, no ZooKeeper. For a learning project and for small/mid-scale production, that's a massive win. Kafka wins at extreme scale (millions/sec) — we're nowhere near that.

### 5.4 What "subject" means (mental model)

Think of subjects like URL paths. You publish to a path:

```
nats pub task.created '{"id":"t_1","title":"Hello"}'
```

Consumers subscribe to paths, with wildcards:

```
nats sub "task.*"    # matches task.created, task.updated
nats sub "task.>"    # matches task.created, task.updated.title, etc. (deeper)
nats sub ">"         # everything
```

Later today you'll use `nats sub ">"` as the smoke test: publish anything, see it.

---

## 6. Temporal — the durable workflow engine

You're not running Temporal today; you're just starting it so it's there when Week 4 needs it. But you should know what it is now, because it **replaces a family of problems** you've probably hand-rolled.

### 6.1 The problem it solves

You want to write this:

```ts
async function runAutomation(event) {
  await notifyAssignee(event);     // hits email API
  await sleep('3 days');            // wait for reply
  if (!replied(event)) {
    await archiveTask(event.taskId);
  }
  await callCustomerWebhook(event);  // may fail; retry up to 9 times
}
```

In plain Node, this breaks the moment:
- The process crashes mid-function — everything after the crash is lost.
- You redeploy — same thing.
- The email API is down for 10 minutes — `notifyAssignee` throws, you lose the in-flight state.
- You can't `sleep('3 days')` — the process won't stay up that long.

Old patchwork: BullMQ jobs with retry config; a database table of "pending workflows"; cron to resume them; careful idempotency. A few thousand lines of fragile code.

### 6.2 What Temporal does

Every `await` in a **workflow function** is a **durable checkpoint**. Temporal's server persists the history of every completed step. If your process crashes mid-step, *another* worker picks up where it left off — state preserved bit-for-bit. `sleep('3 days')` is literally a single line. Retries, timeouts, exponential backoff: configuration, not code.

What we get for free in Syncra:
- The automation engine (Week 4).
- Webhook delivery with retries (Week 5).
- Scheduled workflows (Week 6).
- The GDPR deletion saga (Week 8) — a 10-step compensating transaction that we don't have to write crash-recovery for.

### 6.3 Today

`docker compose up temporal temporal-ui` brings up the server + its web UI at `http://localhost:8080`. You don't write workflows today — you just verify the UI loads.

---

## 7. Meilisearch — search that isn't Elasticsearch

### 7.1 The problem

You want: typeahead task search that tolerates typos, ranks by relevance, lets users filter ("status:done priority:high"). Options historically:

- **Postgres full-text search (`tsvector`)** — decent, free, no new infra. Weak on typos. Our **fallback**, not primary.
- **Elasticsearch** — powerful, ecosystem-rich, but: JVM, cluster ops, shard planning, "why is my cluster yellow", 2 GB RAM minimum for a dev node, complex query DSL.
- **Solr** — Elasticsearch's older sibling; similar cost.

### 7.2 Meilisearch's niche

- One Rust binary. Starts in milliseconds. Uses ~100 MB RAM for small indexes.
- Typo tolerance + ranking rules out of the box — no query DSL tuning.
- **Tenant tokens**: you mint a JWT that restricts searches to `workspace_id = :x` — this is first-class, not an afterthought. Perfect for multi-tenant SaaS.
- Simple HTTP API; zero learning curve for someone who has used Elasticsearch.

Trade-off: Meili is way less feature-rich than Elasticsearch. For our needs (task/project search at SaaS scale — say, up to tens of millions of documents), it's plenty.

---

## 8. MinIO — S3, on your laptop

### 8.1 The problem

Your app uploads files. In prod: S3 / R2 / GCS. In dev: ???

- Running against real S3: costs money, risks leaking test data, requires network, slow iteration.
- Skipping file uploads in dev: half the code paths untested.

### 8.2 MinIO

An S3-compatible object store, runnable locally. Same SDK (`@aws-sdk/client-s3`) — your app code doesn't know or care. Dev targets MinIO; prod targets S3; config difference is three env vars.

We also pull in `mc` (MinIO client CLI) as a tiny helper container for one-off ops: create buckets, list objects, etc.

---

## 9. Mailpit — dev SMTP that catches everything

### 9.1 The problem

Your app sends transactional emails. In dev:
- Sending for real means your test emails go to real people (or bounce).
- Stubbing means you can't eyeball the rendered HTML.

### 9.2 Mailpit

A tiny SMTP server **+** a web UI. Your app sends to `smtp://mailpit:1025`; you view what landed at `http://localhost:8025`. Every invitation email, every notification — you see what the user would have seen.

(It's the modern successor to MailHog, which is now unmaintained.)

---

## 10. Unleash — feature flags

### 10.1 The problem

You want to ship "AI summaries" behind a kill switch — roll it out to 10% of workspaces, then 50%, then all. You want it turn-off-able in a click when something goes wrong.

- **Env var** `AI_ENABLED=true` — all or nothing, and requires a redeploy to change. A "kill switch" that requires redeploy isn't a kill switch.
- **`if (user.isInternal) {...}`** — in code. Same redeploy problem.
- Vendor services (LaunchDarkly, ConfigCat) — paid, hosted. Fine for companies, overkill for a learning project.

### 10.2 Unleash

Open-source feature-flag service. Define a flag in its UI; query from your app. Percentage rollouts, user-ID targeting, gradual rollouts, kill switches — all standard.

We use it behind the **OpenFeature** SDK (a CNCF standard). Your code calls `flagClient.getBooleanValue('ai.summarize.enabled', false, context)` — you can swap Unleash for LaunchDarkly / GrowthBook later without touching call sites.

Unleash needs its own Postgres — we run `unleash-db` as a separate container to keep its schema away from ours.

---

## 11. Observability — why four tools, not one

Modern observability is three signal types:

- **Metrics** — numbers over time. "p99 latency", "requests per second", "queue depth". Cheap to store, coarse-grained.
- **Logs** — structured events per request/error. Rich detail, expensive at scale.
- **Traces** — the story of a single request as it flows through every service. Best for "why is this slow".

A good system lets you pivot between them: see a metric spike → find the matching traces → see the logs from those traces.

### 11.1 Prometheus — metrics

The de-facto open-source metrics database. **Pull-based**: Prometheus periodically scrapes `/metrics` on each service. Its query language (PromQL) is what powers virtually every SRE dashboard you've seen.

### 11.2 Loki — logs

From Grafana Labs. Designed to be Prometheus-compatible in spirit: same labels, same query ergonomics. You don't index the log body (Elasticsearch's mistake at scale) — only labels. Result: extremely cheap to store, fast to filter.

### 11.3 Tempo — traces

Also Grafana Labs. Stores OpenTelemetry traces. Paired with Loki/Prom, you get single-click "show me traces for this error log" and "show me logs for this slow trace".

### 11.4 The OpenTelemetry Collector — the fan-in

Before OTel, every service library had its own "exporter" per backend: one client for Datadog, one for Jaeger, one for Honeycomb, one for Prometheus. Swapping backends meant touching every service.

OpenTelemetry standardised the wire format (OTLP). Services emit **OTLP** to the **Collector**. The Collector fans it out to Prometheus, Loki, Tempo, Sentry, whatever you like — and you can add/remove backends without restarting your apps. That's the whole reason the Collector exists.

### 11.5 Grafana — the single pane

Dashboards + alerts + explore UI for metrics, logs, and traces. One bookmark instead of three.

### Why all of this on Day 1?

We're not instrumenting anything yet (Week 6). But the observability stack is free to run, and if it's there from Day 1, you'll actually use it — instead of "I'll add OTel later" famous last words.

---

## 12. Today's deliverables — what you'll actually build

### 12.1 The `docker-compose.yml` shape

You'll write a single file with ~15 services. Shape looks like:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    # pgvector + pg_partman added via an init script or an extended image
    ports: ['5435:5432']
    volumes: ['pgdata:/var/lib/postgresql/data', './scripts/pg-init:/docker-entrypoint-initdb.d']
    environment: { POSTGRES_USER: syncra, POSTGRES_PASSWORD: syncra, POSTGRES_DB: syncra }
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U syncra -d syncra']
      interval: 5s

  pgbouncer:
    image: edoburu/pgbouncer:latest
    ports: ['6432:6432']
    environment: { DB_HOST: postgres, DB_USER: syncra, DB_PASSWORD: syncra, POOL_MODE: transaction }
    depends_on:
      postgres: { condition: service_healthy }

  redis:
    image: redis:7-alpine
    ports: ['6379:6379']

  nats:
    image: nats:2-alpine
    command: ['-js', '-m', '8222']   # enable JetStream + HTTP monitoring
    ports: ['4222:4222', '8222:8222']

  meilisearch:
    image: getmeili/meilisearch:v1.13
    ports: ['7700:7700']
    environment: { MEILI_MASTER_KEY: dev-master-key }

  temporal:
    image: temporalio/auto-setup:1.25
    environment: { DB: postgresql, DB_PORT: 5432, POSTGRES_USER: syncra, POSTGRES_PWD: syncra, POSTGRES_SEEDS: postgres }
    depends_on:
      postgres: { condition: service_healthy }

  temporal-ui:
    image: temporalio/ui:2.30.0
    environment: { TEMPORAL_ADDRESS: temporal:7233 }
    ports: ['8080:8080']
    depends_on: [temporal]

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports: ['9200:9000', '9201:9001']   # 9000 clashes with ClickHouse later
    environment: { MINIO_ROOT_USER: syncra, MINIO_ROOT_PASSWORD: syncra-secret }

  mailpit:
    image: axllent/mailpit:latest
    ports: ['1025:1025', '8025:8025']

  unleash-db:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: unleash, POSTGRES_PASSWORD: unleash, POSTGRES_DB: unleash }

  unleash:
    image: unleashorg/unleash-server:latest
    ports: ['4242:4242']
    environment: { DATABASE_URL: 'postgres://unleash:unleash@unleash-db:5432/unleash', DATABASE_SSL: 'false' }
    depends_on: [unleash-db]

  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    volumes: ['./infra/otel/config.yaml:/etc/otelcol-contrib/config.yaml']
    ports: ['4317:4317', '4318:4318']   # OTLP gRPC + HTTP

  prometheus:
    image: prom/prometheus:latest
    volumes: ['./infra/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml']
    ports: ['9090:9090']

  loki:
    image: grafana/loki:latest
    ports: ['3100:3100']

  tempo:
    image: grafana/tempo:latest
    command: ['-config.file=/etc/tempo.yaml']
    volumes: ['./infra/tempo/tempo.yaml:/etc/tempo.yaml']
    ports: ['3200:3200']

  grafana:
    image: grafana/grafana:latest
    ports: ['3030:3000']
    volumes:
      - './infra/grafana/provisioning:/etc/grafana/provisioning'
    depends_on: [prometheus, loki, tempo]

volumes:
  pgdata:
  minio:
```

Config files you'll create alongside:

```
infra/
├── otel/config.yaml           # OTel Collector receivers + exporters
├── prometheus/prometheus.yml  # scrape targets
├── tempo/tempo.yaml           # storage backend
├── grafana/provisioning/
│   ├── datasources/*.yaml     # Prometheus, Loki, Tempo pre-wired
│   └── dashboards/*.json      # (empty for today; fill later)
└── pg-init/
    └── 01-extensions.sql      # CREATE EXTENSION vector; CREATE EXTENSION pg_partman;
```

**For pgvector + pg_partman** the easiest path is to use the `imresamu/postgis-gis-arm64:16-4-3-3` OR build a tiny custom image: `FROM postgres:16-alpine` + install the extensions' packages. For learning purposes, the `ankane/pgvector` image has pgvector baked in; add pg_partman via an init script. We'll polish this on Day 2 when we actually use them.

### 12.2 The `Makefile`

```makefile
.PHONY: up down logs ps restart check

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
	npx tsx scripts/check-infra.ts
```

### 12.3 `scripts/check-infra.ts`

A little script that does one network check per service and reports `OK` / `FAIL`. Pseudo-shape:

```ts
// scripts/check-infra.ts
import net from 'node:net';
import { Client as PgClient } from 'pg';
import { connect as natsConnect } from 'nats';
import Redis from 'ioredis';

const checks: Array<[string, () => Promise<void>]> = [
  ['postgres (direct)',   () => checkTcp('localhost', 5435)],
  ['pgbouncer',           () => checkPg('postgresql://syncra:syncra@localhost:6432/syncra')],
  ['redis',               () => checkRedis('localhost', 6379)],
  ['nats jetstream',      () => checkNats('nats://localhost:4222')],
  ['meilisearch',         () => checkHttp('http://localhost:7700/health')],
  ['temporal ui',         () => checkHttp('http://localhost:8080')],
  ['minio',               () => checkHttp('http://localhost:9200/minio/health/ready')],
  ['mailpit ui',          () => checkHttp('http://localhost:8025')],
  ['unleash',             () => checkHttp('http://localhost:4242/health')],
  ['prometheus',          () => checkHttp('http://localhost:9090/-/ready')],
  ['loki',                () => checkHttp('http://localhost:3100/ready')],
  ['tempo',               () => checkHttp('http://localhost:3200/ready')],
  ['grafana',             () => checkHttp('http://localhost:3030/api/health')],
];

for (const [name, check] of checks) {
  try { await check(); console.log(`✔ ${name}`); }
  catch (err) { console.log(`✘ ${name} — ${(err as Error).message}`); process.exitCode = 1; }
}
```

Run with `npx tsx scripts/check-infra.ts` (tsx runs TypeScript directly, no build step).

### 12.4 Verification the user-facing way

```sh
# Start everything
make up

# Make sure each service answers
make check

# Confirm NATS JetStream works end-to-end
nats sub ">" &                                 # subscribe in background
nats pub task.created '{"hello": "world"}'     # you should see it print
kill %1                                        # stop the subscriber

# Confirm Postgres is reachable via PgBouncer
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c 'SELECT 1'
```

---

## 13. Checkpoint — Day 1 done when

- [ ] `node --version` → `v24.x` and `.nvmrc` has `24`.
- [ ] `npm --version` → `10.x`.
- [ ] `npm install` is clean; `npx nx --version` works.
- [ ] `docker compose ps` lists every service as `Up (healthy)`.
- [ ] `make check` (or `npx tsx scripts/check-infra.ts`) prints `✔` for every line.
- [ ] `nats sub ">" &; nats pub test.foo '{"ok":1}'` prints the published message.
- [ ] `psql` via `localhost:6432` (PgBouncer) returns `1`.
- [ ] Grafana loads at `http://localhost:3030` with Prometheus/Loki/Tempo listed as datasources.
- [ ] Temporal UI loads at `http://localhost:8080`.

## 14. Journal prompt (end of day)

Open `docs/journal/<today>.md`. Answer in 2–3 sentences each:

1. Which of these tools did I already know by name but had never used?
2. What was the most surprising thing about the setup?
3. What cost / complexity surprised me — and is it worth it for the problem it solves?

## 15. What we didn't do today — and why

- **No app code changes.** Today is pure infra. Touching app code means you won't finish.
- **No pgvector or pg_partman queries yet.** Extensions are installed; we use them on Day 9 (outbox) and Day 10 (partitioning), and Day 24 (embeddings).
- **No Temporal workflows.** Server is up; we use it on Day 25.
- **No OTel instrumentation in our apps.** Collector is up; we wire SDKs on Day 40.

The point of today is that **nothing you ever build in Syncra will be blocked by infrastructure**. Every service you need exists on a port, waiting.

---

## 16. Further reading (skim, don't memorise)

- npm workspaces — https://docs.npmjs.com/cli/v10/using-npm/workspaces
- PgBouncer — https://www.pgbouncer.org/usage.html
- pgvector — https://github.com/pgvector/pgvector
- pg_partman — https://github.com/pgpartman/pg_partman
- NATS JetStream Walkthrough — https://docs.nats.io/nats-concepts/jetstream/walkthrough
- Temporal — "What is Temporal?" — https://docs.temporal.io/temporal
- Meilisearch tenant tokens — https://www.meilisearch.com/docs/learn/security/tenant_tokens
- OpenTelemetry Collector — https://opentelemetry.io/docs/collector/
- Grafana Loki explained — https://grafana.com/docs/loki/latest/fundamentals/overview/
- Feature flags, best practices — https://docs.getunleash.io/topics/feature-flags/feature-flag-best-practices

---

Good Day 1. Tomorrow you touch SQL.
