status: accepted
date: 2026-05-03
deciders: imon
---

# 0001 — Drizzle ORM over Prisma / TypeORM

## Context and Problem Statement

The application needs an ORM that does not get in the way of:
- raw SQL for RLS policies, triggers, partition DDL, vector indexes
- `SET LOCAL` per request to drive RLS
- migrations that mix tool-generated diffs with hand-written SQL files
- PgBouncer transaction-mode pooling

## Considered Options

- Prisma 5
- TypeORM 0.3.x
- Drizzle ORM 0.36+ + Drizzle Kit
- Sequelize

## Decision Outcome

Chosen: **Drizzle ORM**.

- Plain TypeScript schema; no DSL.
- `sql\`...\`` template tag with bound parameters for arbitrary SQL.
- Migrations are plain `.sql` files — we extend the runner to apply our own RLS/role files in the same step.
- No external query engine; a single dependency tree on the Node side.

## Consequences

- We hand-write RLS, triggers, partitions, role grants. They live in `libs/db-kit/migrations/sql/` and are tracked in `_drizzle_migrations`.
- Less batteries-included than Prisma — no Studio, no auto-generated REST.
- Type ergonomics are very good but not Prisma-grade for deeply nested includes; relational queries are explicit.
