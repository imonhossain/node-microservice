# Syncra — 80-Day Learning & Build Plan (Local + Local-Kubernetes)

A concrete day-by-day plan to learn the new territory in `ARCHITECTURE.md` and ship a demoable Syncra that runs **both** on docker-compose **and** on a local Kubernetes cluster, with the full ARCHITECTURE.md scope — nothing cut.

---

## 0. Ground rules

### Your baseline (already known — not drilled)

- TypeScript, React 18/19, component composition, hooks.
- NestJS — modules, DI, controllers, guards, middleware.
- Basic PostgreSQL, SQL, Docker, Git, CI basics.
- Jest/Vitest, HTTP testing.

### Genuinely new territory (this plan focuses here)

- **Backend:** Drizzle ORM · Postgres RLS + pg_partman + pgvector · NATS JetStream · **transactional outbox** · **Temporal.io workflows + Schedules** · Meilisearch tenant tokens · Casbin · Auth.js v5 or Clerk · OpenFeature + Unleash · SOPS · internal S2S JWTs · BullMQ.
- **Frontend:** TanStack Router · tRPC v11 · Zustand · Tailwind v4 · shadcn/ui + Radix · Yjs + Hocuspocus + Tiptap 3 · `@tanstack/query-persist-client` for offline · Lingui · OpenTelemetry browser · Sentry Session Replay · Biome.
- **Distributed systems:** outbox, CQRS-lite projections, **saga with compensation (GDPR deletion)**, idempotency, circuit breakers, bulkheads, graceful degradation, DLQs, SLOs with multi-window burn-rate alerts.
- **AI/data:** embeddings worker, pgvector HNSW, ClickHouse CDC, **dbt-clickhouse full model hierarchy**.
- **Product:** **PostHog** funnels, retention, session replay, feature-flag experimentation.
- **Platform:** **local Kubernetes (k3d / kind) · Helm charts · Argo Rollouts · SOPS + age secrets · service mesh (Linkerd)**.
- **Architecture milestone:** **extract `identity` to its own service** with its own DB and gRPC interface — the one-time deliberate splitting exercise.
- **Enterprise auth:** **SAML SSO + SCIM** (WorkOS or self-hosted via `passport-saml`).

### Budget & cadence

- **80 calendar days · 6 active days/week · ~5 hours/day → ~340 focused hours.**
- Each active day: 0:30 plan · 4:00 build · 0:15 commit · 0:15 journal (`docs/journal/YYYY-MM-DD.md`).
- Weekly rest day = catch-up + ADRs + record a 1-minute progress demo.
- **ADRs are non-optional** — target 20 ADRs by Day 80.

### What's in scope (ship all of this)

✅ Foundations, identity, workspaces, RLS · projects + tasks + JSONB custom fields · outbox + NATS + audit (partitioned) · realtime CRDT edits (Yjs + Hocuspocus) · search (Meili) · embeddings + semantic search + RAG summaries · Temporal automation + Schedules · notifications · files · feature flags (OpenFeature + Unleash) · public API + API keys + scopes + idempotency · outbound webhooks with replay UI · workspace export + **full GDPR deletion saga with compensation** · resilience patterns · full observability (OTel → Tempo/Loki/Prom → Grafana) · Sentry · **PostHog** · **full dbt model hierarchy + Metabase dashboards** · Playwright E2E per feature.
✅ **Deployment:** **local Kubernetes (k3d) via Helm charts · Argo Rollouts canary · SOPS-encrypted secrets · Linkerd service mesh with mTLS**.
✅ **Architecture:** **extract `identity` to its own service + DB + gRPC contract**.
✅ **Enterprise auth:** **SAML SSO + SCIM provisioning with workspace-level IdP config**.

### What's still out (explicitly)

❌ Payment/billing (always out of scope).
❌ Mobile apps (separate project).
❌ Production deploy to cloud (local k8s only; cloud is "push a button" from there).

---

## Pre-flight (Day 0)

- Re-read `ARCHITECTURE.md` cover to cover. Mark anything you don't recognise.
- Ensure Docker has ≥ 10 GB RAM / 4 CPUs; 50 GB disk free.
- Install: Node 22, pnpm, Docker Desktop, `psql`, `nats` CLI, `temporal` CLI, `mc` (MinIO), `kubectl`, `helm`, `k3d` (or `kind`), `linkerd` CLI, `sops`, `age`, `argocd` CLI.
- Create: GitHub repo (with Actions), Temporal Cloud dev namespace (optional), OpenAI or Anthropic key, Sentry org (free tier), PostHog Cloud free account (or self-host in Week 7), WorkOS free tier (for SSO later).
- Generate an `age` keypair for SOPS; store private key in `~/.config/sops/age/keys.txt`.
- Create `docs/journal/` and `docs/adr/` folders. Copy MADR-4 template into `docs/adr/template.md`.

---

## Week 1 — Foundations, Identity, Workspaces, RLS (Days 1–7)

### Day 1 — Infra bootstrap

**Build**
- Migrate Nx workspace to pnpm (`pnpm import`).
- Full `docker-compose.yml`: postgres:16 + pgvector + pg_partman · pgbouncer · redis:7 · nats:2-alpine `-js` · meilisearch · temporal + temporal-ui · minio + mc · mailpit · unleash (+unleash-db) · otel-collector · tempo · loki · prometheus · grafana.
- `make up`, `make down`, `make logs`.
- `scripts/check-infra.ts` smoke-tests each service.

**New**: pnpm workspace protocol · pg_partman init-time partitioning · JetStream vs core NATS.

**Ship**: every container green; `nats sub '>'` sees a test publish; Postgres reachable via PgBouncer.

---

### Day 2 — Drizzle + first migrations + RLS

**Build**
- `libs/db-kit`: Drizzle schema, migration runner, raw-SQL files for RLS + partitions.
- Tables: `users`, `workspaces`, `workspace_members`, `invitations`.
- RLS policies using `current_setting('app.workspace_id')`.
- `libs/db-kit/with-ctx.ts` wraps each request transaction with `SET LOCAL`.
- Testcontainers integration test — cross-tenant reads as an unprivileged role must fail.

**New**: Drizzle relational queries · `SET LOCAL` semantics · Postgres policy composition.

**ADR 0001** — Drizzle over Prisma/TypeORM.

---

### Day 3 — Auth.js v5 (or Clerk) + identity module

**Build**
- Pick one: Auth.js v5 self-hosted *or* Clerk.
- `apps/api/src/modules/identity`: `/me`, sign-out, `external_id` mapped to `users`.
- Cookie session (`__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`).
- Frontend: minimal `/login` page, post-login shell.

**New**: JWKS caching · cookie flags discipline · Auth.js v5 adapter or Clerk middleware.

**ADR 0002** — Auth.js v5 vs Clerk.

---

### Day 4 — Workspaces + memberships + invitations + Casbin

**Build**
- `workspace` module: create, rename, invite, accept, list members.
- Invitation tokens: single-use, 7-day TTL; email via Mailpit.
- `libs/auth-kit`: Casbin model + `policy.csv`; `@RequireAction('workspace:invite')`; middleware sets `app.workspace_id` from the route param.
- Frontend: workspace switcher, "create workspace" dialog, invite form.

**New**: Casbin model language · invitation-token security.

---

### Day 5 — tRPC end-to-end

**Build**
- `@trpc/server` on NestJS; `@trpc/react-query` on frontend.
- `libs/contracts` exposes router types to the client with no codegen.
- Procedures: `workspace.list/create/invite`, `me.get`.

**New**: `inferReactQueryProcedureOptions` · Zod input/output single source of truth.

**ADR 0003** — tRPC over REST for web edge.

---

### Day 6 — TanStack Router + layout + shadcn/ui

**Build**
- File-based routes: `__root.tsx`, `_auth/login.tsx`, `_app/*`, `_app/w.$workspaceId/*`.
- `beforeLoad` on `_app` asserts session; 401 → `/login`.
- shadcn/ui: Button, Input, Dialog, DropdownMenu, Sheet, Toast (Sonner), cmdk shell.
- Tailwind v4 `@theme` tokens; dark-mode `[data-theme]`.

**New**: TanStack Router loader semantics · Tailwind v4 `@theme` (no config file).

---

### Day 7 — Rest + polish + weekly demo

- Finish Week 1 gaps; write outstanding ADRs.
- Record 60-s demo (sign-in → invite → accept).
- `size-limit` checked in with initial budget.

---

## Week 2 — Projects, Tasks, Outbox, Audit (Days 8–14)

### Day 8 — Projects + tasks + JSONB custom fields
Tables: `projects`, `tasks` (with `custom_fields jsonb` + GIN index), `custom_field_definitions`. RLS everywhere. tRPC CRUD. Task list + create-task dialog on the frontend. Filter by jsonb fields.

### Day 9 — Transactional outbox
`outbox` + `processed_events` tables. `libs/event-bus/outbox.ts` — `OutboxService.enqueue()` in the domain tx. `libs/event-bus/relay.ts` — publishes to NATS with `msgId = event.id`. First events: `task.created/updated/deleted`. Zod schemas in `libs/contracts/events`. **ADR 0004 — Outbox pattern.**

### Day 10 — NATS JetStream + audit consumer
`apps/workers` (NestJS standalone). Audit consumer: writes to `events` (monthly-partitioned via pg_partman). `processed_events` dedupe. **ADR 0005 — NATS JetStream.**

### Day 11 — Activity panel
`events.forEntity` tRPC; frontend activity sidebar on a task page.

### Day 12 — Subtasks, assignees, labels
Tables + RLS + CRUD. Assignee picker; label chips using design tokens.

### Day 13 — Optimistic updates + SSE invalidation (pre-realtime)
`onMutate`/`onError` rollback pattern. Temporary SSE endpoint fans out NATS events to connected users; client invalidates queries on relevant events.

### Day 14 — Rest + Testcontainers suite
Integration tests for outbox + consumer (PG + NATS). ADR rewrites. Weekly demo.

---

## Week 3 — Realtime Collaboration (Days 15–21)

### Day 15 — Hocuspocus server
`apps/realtime`. Hocuspocus + `y-postgres` persistence. Short-JWT auth issued by `api`. Redis adapter wired.

### Day 16 — Yjs + Tiptap 3 editor
Tiptap 3 with Collaboration + CollaborationCursor. `@hocuspocus/provider` per task (provider pool).

### Day 17 — Awareness (presence)
Live cursors (colour from user-id hash). Online-users avatar stack. Typing indicators.

### Day 18 — Realtime → NATS
Hocuspocus `onChange` (debounced) emits `task.description.updated` to NATS. Audit consumer picks it up — proves realtime edits are audited.

### Day 19 — Offline CRDT (IndexedDB)
`y-indexeddb` alongside `y-hocuspocus`. Offline edit → reconnect → clean merge. Connection-state indicator.

### Day 20 — Offline mutation queue (non-Yjs)
`@tanstack/query-persist-client` → IndexedDB. `networkMode: 'offlineFirst'`. `broadcast-channel` wakes tabs on reconnect. Offline banner with pending counter.

### Day 21 — Rest / Playwright collab test
Two-browser test asserts merged state. **ADR 0006 — Yjs + Hocuspocus for collab.** Weekly demo.

---

## Week 4 — Search, AI, Temporal Automation (Days 22–28)

### Day 22 — Meilisearch indexer
`search-indexer` consumer. `search` module mints tenant tokens scoped by `workspace_id`.

### Day 23 — Search UI
Typeahead search; filters synced to route search params (Zod schema). Flag-gated fallback to Postgres FTS.

### Day 24 — pgvector + embeddings
`task_embeddings (vector(1536))` + HNSW index. Embeddings worker on `task.created/updated`. `ai.similar` tRPC procedure.

### Day 25 — Temporal TS SDK intro
`workers/temporal` setup. `HelloTemporalWorkflow` run via the web UI. Time-skipping test scaffold.

### Day 26 — Automation rule engine
`automation_rules` + `automation_actions` tables. Rule evaluator: `startWorkflow(RunRuleWorkflow, …)` with `workflowId = rule-${ruleId}-event-${eventId}` for idempotency.

### Day 27 — Automation activities
`notifyAssignee`, `archiveTask`, `setField`, `callWebhook`. Activities call `api` via internal S2S JWT so RLS + audit fire. **ADR 0007 — Temporal for durable workflows.**

### Day 28 — Rest + rule-builder UI
Minimal builder (trigger + one action). Weekly demo.

---

## Week 5 — Notifications, Files, Flags, Public API, Webhooks (Days 29–35)

### Day 29 — Notifications
`notifications` table; in-app inbox; BullMQ email worker → Mailpit.

### Day 30 — File uploads
`file` module: signed upload URL → MinIO; signed download. Drag-and-drop on tasks. `file-postprocessing` worker for thumbnails.

### Day 31 — OpenFeature + Unleash
Server + React SDKs. `/api/bootstrap` returns user + memberships + flag snapshot + time skew. Zustand root store hydrated before the router renders.

### Day 32 — Public API + API keys
`api_keys` table (Argon2id-hashed secret, plaintext `prefix` for lookup, `scopes text[]`). `/v1/*` route tree inside NestJS. `@Scopes()` decorator; Redis token-bucket rate limit per key. `Idempotency-Key` → 24h Redis cache. **ADR 0008 — Public API key format + scopes.**

### Day 33 — Webhook subscriptions + signing
`webhook_subscriptions` + `webhook_deliveries` tables. SSRF filter (DNS resolve + reject private IPs). `libs/webhook-kit` HMAC signer with dual-secret rotation.

### Day 34 — Webhook delivery workflow
Temporal `DeliverWebhook(subId, eventId)`. Retry ladder 30 s → 2 m → 10 m → 30 m → 2 h → 6 h → 12 h, cap 24 h or 9 attempts. Deliveries logged. Manual replay via tRPC.

### Day 35 — Rest + Playwright E2E
API key issuance → `curl` → UI reflects → webhook receiver sees signed POST. Weekly demo.

---

## Week 6 — Scheduled, Analytics (lite), Export, Resilience, SLOs (Days 36–42)

### Day 36 — Temporal Schedules
`PruneOutbox` every 10 min · `EnsureAuditPartitionsAhead` monthly · `SendDailyDigest` at user's local 8 am (parent→child pattern for per-user timezones). Policies: `overlap: SKIP`, `catchupWindow: 1h`.

### Day 37 — Analytics CDC (skeleton)
ClickHouse container + `analytics.raw_events` table. `analytics-cdc` consumer batches 1000 events/1 s, HTTP-inserts. Wait on full dbt to Week 7.

### Day 38 — Workspace export (streaming zip)
`export_jobs` table. Temporal workflow streams each tenant table to NDJSON → zip → MinIO multipart → email signed URL. 7-day expiry schedule prunes bundles.

### Day 39 — Resilience patterns
`libs/resilience/http-client.ts` — opossum + `AbortController`. Wrap Meili, OpenAI/Anthropic, MinIO, Temporal signals, webhook delivery. Fault-injection test: stop Meili, search falls back to FTS. Metrics: `breaker_state{dep}`, `breaker_trips_total{dep}`. **ADR 0009 — Resilience patterns.**

### Day 40 — Observability end-to-end
OTel on api + realtime + workers + browser. `traceparent` propagates from browser to DB. Grafana dashboards per service. Sentry server + React; source-map upload in CI; release = short git SHA.

### Day 41 — SLOs + burn-rate alerts
Prometheus recording rules + alert rules (tRPC mutation error rate, webhook delivery success, CDC lag). Force an error, watch the page fire. **ADR 0010 — Modular monolith, not microservices** (formally commit the one from ARCHITECTURE.md §25).

### Day 42 — Rest + full golden-path E2E
Playwright: sign-up → invite → create project/task → collab-edit → automation fires → webhook delivers → export. Weekly demo.

---

## Week 7 — Frontend Hardening + PostHog + Full dbt (Days 43–49)

### Day 43 — Frontend hardening
`size-limit` budgets tuned per route (gate in CI). Lighthouse CI budgets (LCP < 2.5 s, TBT < 200 ms, CLS < 0.1). Axe-core sweep; fix top 5 a11y issues. Route-level error boundaries; Sentry release tagging.

### Day 44 — PostHog setup
Option A (recommended for learning): self-host PostHog via their Helm chart (wait until Week 9) or their docker-compose. Option B: PostHog Cloud free tier — quicker to wire.
- Frontend `posthog-js` init with user + workspace properties.
- Backend `posthog-node` for server-side events (automation fires, webhook delivered, export completed).
- Autocapture configured with a denylist of PII-bearing selectors.

### Day 45 — PostHog funnels + retention + replay
- Funnels: sign-up → create-workspace → invite → create-task → task completed.
- Retention: D1/D7/D28 by workspace.
- Session replay with PII masking (`data-ph-no-capture` attribute on sensitive elements).
- PostHog feature-flag experiments wired alongside OpenFeature (PostHog provides the experiment analytics; OpenFeature evaluates).

### Day 46 — dbt-clickhouse project scaffold
- `dbt/` top-level with `dbt_project.yml`, `profiles.yml`, source defs.
- Staging layer: `stg_events`, typed cast of `analytics.raw_events` per event family (`stg_task_events`, `stg_workspace_events`, `stg_user_events`).

### Day 47 — Intermediate + marts models
- Intermediate: `int_task_lifecycle` (task state transitions over time), `int_workspace_activity_daily`.
- Marts (business-facing):
  - `mart_tasks_daily` — tasks created/completed/archived per workspace per day.
  - `mart_workspace_engagement` — DAU/WAU/MAU per workspace.
  - `mart_automation_success` — rule→action fan-out + success rate.
  - `mart_funnel_user_activation` — first-value funnel.

### Day 48 — dbt tests + scheduling
- Generic tests: `not_null`, `unique`, `relationships`.
- Custom singular test: no row with null `workspace_id` in any mart (tenancy invariant).
- Schedule nightly via a Temporal workflow (`RunDbtMarts`) calling `dbt run --select marts` via an activity.
- `dbt docs` served via a sidecar; link from Metabase.

### Day 49 — Rest + Metabase dashboards on marts
One dashboard per mart; each with 3 charts. Embed links in the admin area behind `analytics.metabase.enabled` flag. Weekly demo.

**ADR 0011 — PostHog + OpenFeature side-by-side.**
**ADR 0012 — dbt-clickhouse model hierarchy (staging → int → marts).**

---

## Week 8 — Full GDPR Deletion Saga (Days 50–56)

### Day 50 — Saga design + compensation matrix
- Whiteboard the saga in `docs/design/gdpr-saga.md`:

  | Step                        | Forward                         | Compensation                       |
  | --------------------------- | ------------------------------- | ---------------------------------- |
  | 1. revokeSessions           | invalidate IdP sessions          | noop (forward-safe)                |
  | 2. revokeApiKeys            | `revoked_at = now()` on all keys | reinstate if step fails             |
  | 3. removeFromAllWorkspaces  | nullify memberships              | restore memberships from backup row |
  | 4. anonymiseAuthoredRows    | `created_by = <system-actor>`    | restore original author             |
  | 5. deleteAttachments        | S3 delete                        | noop (tombstoned before delete)    |
  | 6. deleteEmbeddings         | DELETE from `task_embeddings`    | re-compute from source on fail     |
  | 7. deleteFromSearch         | Meili delete-by-filter           | reindex from source                |
  | 8. hashUserIdInCH           | `ALTER UPDATE` in ClickHouse      | noop                               |
  | 9. scrubAuditPII            | nullify `actor_id`; scrub payload.email/name | noop            |
  | 10. scrubUserRow            | replace name with "Deleted user"; clear avatar_url | noop   |

- Legal-hold flag on `users.legal_hold`: if set, the saga fails fast with a clear error surfaced to the admin.

### Day 51 — Activities (idempotent)
Implement each activity as idempotent (safe to re-run). Each writes a compensation-journal row (`deletion_step_journal`) so a later step failing can unwind precisely what it did.

### Day 52 — Saga workflow
Temporal workflow `DeleteUserSaga(userId)`: runs steps in order; on any failure runs `compensate` for each previously-completed step in reverse. Emits `user.deletion.requested` at start, `user.deletion.completed` at end.

### Day 53 — Admin compliance UI
- `/admin/compliance/requests` list with status.
- Drill-in view with step-by-step progress (pulled from Temporal workflow state + activity history).
- "Force abort" button (workflow signal) guarded by a second confirmation.

### Day 54 — Legal hold + audit of deletion requests
- Legal-hold flag UI.
- Every deletion request + its compensating events land in the **audit log** (the meta-audit — you audit the audit).
- Notify the user (email) at request, completion, or abort.

### Day 55 — Saga tests
- Temporal time-skipping tests for each happy path.
- Injected failures at each step verifying compensation runs correctly.
- Concurrency test: two simultaneous deletion requests for the same user → second no-ops.

### Day 56 — Rest + weekly demo
Demo: request deletion for a test user → watch the saga in Temporal UI → confirm Postgres / ClickHouse / Meili / S3 all scrubbed. **ADR 0013 — Anonymise-over-cascade for GDPR.**

---

## Week 9 — Kubernetes + Helm + Service Mesh (Days 57–63)

### Day 57 — Local cluster + Kubernetes refresher
- `k3d cluster create syncra --agents 3` (or `kind`).
- Verify `kubectl get nodes`; deploy a hello-world to confirm.
- Install `helm`, `linkerd`, `argocd` CLIs.
- Install `cert-manager` (for TLS within cluster), `ingress-nginx`.

**New for those rusty:** Deployments vs Pods vs StatefulSets · Services vs Ingress · `kubectl` debug flow (`logs`, `describe`, `exec`, `port-forward`).

### Day 58 — Helm chart for `api`
- `infra/helm/api/` chart: Deployment, Service, HorizontalPodAutoscaler, PodDisruptionBudget, readiness + liveness probes (separate endpoints), ConfigMap, preStop hook (30 s drain).
- Tracing: OTel env vars auto-injected.
- Secrets: SOPS-encrypted file mounted via the `helm-secrets` plugin.

### Day 59 — Helm charts for `realtime`, `workers`, `frontend`
- `realtime`: sticky sessions via ingress annotations; HPA on WS connection count.
- `workers`: HPA on NATS consumer lag (custom metric via keda-http adapter or Prometheus adapter).
- `frontend`: static-served from nginx; baked image with content-hashed assets.

### Day 60 — Stateful dependencies via Helm
- Bitnami `postgresql-ha` chart OR Zalando `postgres-operator` for a tiny HA cluster locally.
- `redis` via Bitnami chart.
- `nats` via the official NATS chart (JetStream-enabled).
- `meilisearch` via official chart.
- `minio` via official chart (4-node distributed mode).
- `temporal` via the official Helm chart.
- `clickhouse` via the official operator.

### Day 61 — Secrets (SOPS + age) + config
- Encrypt dev + prod value files with `sops --encrypt --age <recipient>`.
- `helm-secrets` plugin decrypts at install time using the age key from a K8s secret (which is created out-of-band).
- ConfigMap for non-secret config per environment.

### Day 62 — Argo Rollouts canary
- Install Argo Rollouts.
- Convert `api` Deployment to a Rollout with 5% → 25% → 50% → 100% steps and analysis templates (Prometheus query for error rate must stay < 1%).
- Force a bad deploy; watch auto-rollback.

### Day 63 — Linkerd service mesh + mTLS
- `linkerd install | kubectl apply -f -`; annotate namespaces for auto-injection.
- Verify mTLS between pods via `linkerd viz edges`.
- ServiceProfile for `api` to expose per-route latency.
- Set an authorization policy: `workers` can only call `/s2s/*` on `api` (belt-and-braces for the internal JWTs).
- Rest. **ADR 0014 — Linkerd over Istio** (for the smaller-surface-area argument).

---

## Week 10 — Identity Service Extraction (Days 64–70)

This is the one-time deliberate "extract a bounded context" exercise. You'll feel the tax first-hand — that's the point.

### Day 64 — Design the split
- Write `docs/design/extract-identity.md`:
  - Tables that move: `users`, `user_sessions`, `invitations` (identity-owned).
  - Tables that stay in `api`: `workspaces`, `workspace_members` (they reference users by id; foreign-key crosses services, which is now a logical constraint, not physical).
  - New service: `apps/identity` — NestJS with its own Drizzle schema + own Postgres schema (`identity.users`, `identity.user_sessions`).
  - Contract: `libs/contracts/identity.proto` (gRPC). Methods: `GetUser`, `BatchGetUsers`, `ListMembershipsForUser`, `CreateInvitation`, `AcceptInvitation`.

### Day 65 — Scaffold `apps/identity`
- New NestJS service with its own Helm chart.
- Its own Drizzle schema + migrations.
- `@nestjs/microservices` gRPC transport.
- Separate Postgres schema (or a whole separate DB — choose and document).

### Day 66 — Move identity tables + data migration
- **Expand**: add `identity.users`, `identity.sessions` alongside old `users`; backfill; dual-write behind a flag.
- Initial sync via `pg_dump | pg_restore` for dev.
- Update `api` to start reading from identity via gRPC for new code paths, falling back to local table for old paths.

### Day 67 — Migrate callers
- Sweep codebase for `db.users` access; replace with `identity.getUser(...)` gRPC calls.
- Batch-endpoint pattern: any loop over user ids uses `BatchGetUsers` to avoid N+1.

### Day 68 — **Contract**: drop the old tables
- Remove dual-write flag; delete `api.users` / `api.invitations`.
- Remove the feature flag.
- Deploy; monitor error rate and SLO burn.

### Day 69 — Cross-service testing
- Contract tests: pact-style consumer tests in `api` against a stubbed identity.
- Chaos: kill the identity pod mid-request; verify circuit breaker trips; most of the app still works (degraded).

### Day 70 — Rest + ADR
**ADR 0015 — Extracted identity service** with a brutally honest consequences section:

- Lines of code: +X across contracts/stubs.
- Deploy choreography: 2× the pipelines.
- Observed latency cost for common paths: measured p50/p99 before vs after.
- Operational gain: none, for now, at this scale. Lesson noted for when extraction is *actually* justified.

---

## Week 11 — SSO / SAML + SCIM (Days 71–77)

### Day 71 — Choose implementation
- **Option A (recommended):** WorkOS — hosted, one SDK, covers SAML + SCIM + OIDC. Free tier covers dev. Less learning about the protocols themselves but more realistic.
- **Option B:** Self-host via `passport-saml` + `scim2-compliant-server`. Deeper protocol learning, more code.

Pick one. Document in `docs/adr/0016-sso-implementation.md`.

### Day 72 — SAML in the identity service
- Add a SAML endpoint (`/sso/acs`) to `apps/identity`.
- Support IdP-initiated and SP-initiated flows.
- Map SAML assertions to `users.external_id`; if the email doesn't exist, JIT-provision a user.

### Day 73 — Workspace-level SSO config
- Tables: `workspace_sso_configs (workspace_id, provider, idp_metadata_xml, enforce_sso boolean, created_at)`.
- Admin UI: upload IdP metadata XML; flip `enforce_sso`; test-connection button.
- Login flow: if the email's domain matches a workspace with enforce_sso, redirect to the IdP instead of the default login.

### Day 74 — SCIM provisioning
- SCIM 2.0 endpoints in `apps/identity` (`/scim/v2/Users`, `/scim/v2/Groups`).
- Bearer-token auth using a SCIM-specific token issued per workspace.
- User create / update / deactivate map to `identity.users`; group sync maps to `workspace_members`.

### Day 75 — Admin compliance + audit
- `sso_events` audit trail (login, JIT-provision, SCIM sync, config change).
- "SSO activity" tab in workspace admin.

### Day 76 — Testing with a local IdP
- Run `simplesamlphp` in Docker as a local test IdP.
- E2E: configure metadata in Syncra → sign in via simplesamlphp → JIT-provision.
- E2E for SCIM: run Okta-style SCIM test against the endpoints (using the SCIM test tools).

### Day 77 — Rest + weekly demo + ADR refinement
Demo: add simplesamlphp as IdP → enforce SSO on a workspace → user's next visit is redirected to the IdP → on return they're in. **ADR 0017 — SAML + SCIM in identity service.**

---

## Week 12 — Final Hardening, Demo, Retro (Days 78–80)

### Day 78 — Full security + performance pass
- CSP + HSTS audit at the ingress.
- `pnpm audit --prod`; upgrade or justify each finding.
- Load test with k6: 1k RPS writes, 10k WS connections. Fix any SLO regressions.
- Threat-model review against the `ARCHITECTURE.md` §19 checklist — every box checked.
- Rotate the S2S JWT signing key end-to-end; rotate a webhook secret; verify dual-signature window.

### Day 79 — Polish + production-readiness checklist
- Runbooks in `docs/runbooks/`: DB failover, NATS lag spike, webhook storm, Temporal worker crash, Meilisearch reindex, emergency tenant export, GDPR deletion abort, identity service down.
- Grafana dashboards: one per service + business KPI from PostHog.
- README and ARCHITECTURE.md diffed against the built reality — anything drifted is fixed.
- Seed script: creates a demo workspace with 3 users, 2 projects, 20 tasks, an automation rule, an active webhook subscription, an API key.

### Day 80 — Demo + retro + release
- Record a **10-minute demo video** walking through: sign-in (SSO) → workspace → real-time task editing → semantic search → automation triggers → webhook delivered → public API call via `curl` → export bundle received → admin views audit log → trigger a GDPR deletion saga → dbt dashboard in Metabase → k8s deployment (`kubectl get pods`) → Argo Rollouts canary view → service mesh in `linkerd viz`.
- Write `docs/retrospective.md`: what was hardest, what surprised you, what you'd do differently, what the identity-extraction exercise taught you.
- Tag release `v1.0.0`.
- Post the demo on LinkedIn / a blog — this is portfolio-grade work.

---

## Success criteria (Day 80 gate)

- [ ] All items in the "In scope" list working end-to-end in **both** docker-compose and local k8s.
- [ ] ≥ 17 ADRs committed.
- [ ] Daily journal in `docs/journal/` — no gaps > 2 days.
- [ ] Testcontainers integration tests cover outbox, consumers, Temporal, saga.
- [ ] Playwright E2E golden paths: auth (password + SSO), tasks, realtime, public API, webhooks, export, GDPR deletion.
- [ ] Grafana: service dashboards + SLO dashboards + one proven-to-fire alert.
- [ ] PostHog: sign-up funnel populated, one retention chart, session replay proven.
- [ ] dbt: `dbt build` green; `dbt docs` served; 4+ marts; Metabase dashboards on each.
- [ ] k8s: `helm install` deploys the full stack; Argo Rollouts canary works; Linkerd shows mTLS.
- [ ] Identity service extracted; `api.users` table removed; all callers use gRPC.
- [ ] SSO: simplesamlphp IdP works; SCIM sync tested.
- [ ] ARCHITECTURE.md matches reality (or explicit "deferred" markers where it doesn't).
- [ ] 10-minute demo video recorded.

---

## Contingency rules

- **If you're 2+ days behind end of Week 3**: drop offline mutation queue; skip audit-panel polish; cut activity pretty-printer.
- **If you're 2+ days behind end of Week 5**: drop webhook manual-replay UI; keep API only; cut the custom rule-builder UI for a JSON textarea.
- **If you're 3+ days behind end of Week 7**: cut dbt marts from 4 → 2; skip Metabase dashboards for cut marts; keep PostHog Cloud, skip self-host.
- **If you're 3+ days behind end of Week 9**: skip Linkerd (mTLS via cloud-provider ingress later); keep Argo Rollouts; keep Helm charts.
- **If you're 4+ days behind end of Week 10**: abort identity extraction cleanly and write the ADR anyway — a "we started and rolled back, here's what we learned" ADR is also valuable. Reset `main` to the pre-extraction commit.
- **If you're 3+ days behind end of Week 11**: do SAML only via WorkOS (not self-hosted); skip SCIM; document it as a deferred extension.
- **Never cut**: outbox, RLS, Playwright golden-path, Temporal workflow, Yjs editor, GDPR saga, PostHog funnels, at least one dbt mart, at least one Helm deploy. These are the architecturally non-negotiable lessons.

---

## Key learning resources (bookmark Day 0)

- Drizzle — https://orm.drizzle.team/
- Postgres RLS — https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- pg_partman — https://github.com/pgpartman/pg_partman
- pgvector — https://github.com/pgvector/pgvector
- NATS JetStream — https://docs.nats.io/nats-concepts/jetstream
- Temporal TS SDK — https://docs.temporal.io/develop/typescript
- Temporal Schedules — https://docs.temporal.io/schedule
- Yjs — https://docs.yjs.dev/
- Hocuspocus — https://tiptap.dev/docs/hocuspocus/introduction
- Tiptap 3 Collab — https://tiptap.dev/docs/editor/extensions/functionality/collaboration
- Meilisearch tenant tokens — https://www.meilisearch.com/docs/learn/security/tenant_tokens
- OpenFeature — https://openfeature.dev/
- Unleash — https://docs.getunleash.io/
- Auth.js v5 — https://authjs.dev/
- Casbin — https://casbin.org/docs/overview
- tRPC — https://trpc.io/docs
- TanStack Router — https://tanstack.com/router
- shadcn/ui — https://ui.shadcn.com/
- Tailwind v4 — https://tailwindcss.com/blog/tailwindcss-v4
- OpenTelemetry JS — https://opentelemetry.io/docs/languages/js/
- Google SRE Workbook ch. 5 (burn-rate) — https://sre.google/workbook/alerting-on-slos/
- MADR 4 ADR — https://adr.github.io/madr/
- PostHog self-host — https://posthog.com/docs/self-host
- dbt-clickhouse — https://docs.getdbt.com/docs/core/connect-data-platform/clickhouse-setup
- ClickHouse — https://clickhouse.com/docs
- Kubernetes — https://kubernetes.io/docs/concepts/
- Helm — https://helm.sh/docs/
- k3d — https://k3d.io/
- Argo Rollouts — https://argo-rollouts.readthedocs.io/
- SOPS + age — https://github.com/getsops/sops · https://github.com/FiloSottile/age
- Linkerd — https://linkerd.io/2/overview/
- WorkOS (SAML + SCIM) — https://workos.com/docs
- passport-saml — https://github.com/node-saml/passport-saml
- simplesamlphp test IdP — https://simplesamlphp.org/docs/contrib_modules/exampleauth:exampleauth.html

---

## How to use this plan

- **Don't treat days as rigid.** You'll compress some days and stretch others. Weekly rest days absorb variance; Week 12 is the global buffer.
- **Commit tiny + often.** A clean commit history becomes a portfolio artefact. One feature = one PR = one merge to `main`.
- **When you hit a wall**, write the ADR of what you chose *before* fixing it. That's when trade-offs are clearest.
- **The identity-extraction week is where the biggest lesson lives.** Keep the "what we learned" part of ADR 0015 brutally honest — that's the portfolio-differentiating content.
- **If a day finishes early**, pick a stretch item (webhook replay UI, RAG summaries, richer rule-builder) instead of inflating the next day's scope.

Good luck. Ship it.
