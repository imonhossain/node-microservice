# Syncra

An Nx monorepo with a React 19 frontend and a NestJS backend backed by PostgreSQL (Docker).

## Stack

| Layer        | Tech                                                                |
| ------------ | ------------------------------------------------------------------- |
| Monorepo     | Nx 22 · npm workspaces                                              |
| Frontend     | React 19 · Vite · Tailwind CSS 3 · TanStack Query 5 · Vitest        |
| Backend      | NestJS 11 · TypeORM · `@nestjs/config`                              |
| Database     | PostgreSQL 16 (Alpine) running in Docker Compose                    |

## Project layout

```
apps/
  frontend/        # React 19 + Vite + Tailwind + TanStack Query
  backend/         # NestJS + TypeORM
packages/          # shared libraries (empty for now)
docker-compose.yml # Postgres 16 service
.env               # local env values (gitignored)
.env.example       # copy this to .env
```

## Requirements

- **Node.js** ≥ 20.19 or ≥ 22.13 (currently built on Node 22)
- **npm** 10+
- **Docker** with Docker Compose v2 (Docker Desktop on macOS/Windows is fine)

## One-time setup

```sh
# 1. install dependencies
npm install

# 2. create your local env file
cp .env.example .env
```

Review `.env` and adjust credentials/ports if needed. The default DB host port is **5435** (the container's own 5432 is mapped to host 5435 to avoid clashing with an already-running Postgres on `5432`). Change `DB_PORT` in both `.env` and `docker-compose.yml` if you prefer a different port.

## Running the apps

Start the services in separate terminals (or run the combined `dev` script).

```sh
# Terminal 1 — Postgres
npm run db:up           # start Postgres in the background
npm run db:logs         # (optional) follow logs
npm run db:down         # stop and remove the container

# Terminal 2 — Backend (NestJS)
npm run backend         # → http://localhost:3000/api

# Terminal 3 — Frontend (React + Vite)
npm run frontend        # → http://localhost:4200

# Or run frontend + backend together
npm run dev
```

Quick health check once the backend is up:

```sh
curl http://localhost:3000/api/health
# → {"status":"ok","uptime":...}
```

## Everyday commands

```sh
# build
npx nx build frontend
npx nx build backend

# test
npx nx test frontend
npx nx test backend

# lint / typecheck
npx nx lint frontend
npx nx lint backend
npx nx typecheck backend

# run any target on any project
npx nx <target> <project>

# run the same target across several projects
npx nx run-many -t build -p frontend,backend

# visualise the project graph
npx nx graph
```

Targets are either [inferred automatically](https://nx.dev/concepts/inferred-tasks) or defined in each app's `project.json` / `package.json`.

## Environment variables

Defined in `.env` (see `.env.example`):

| Variable         | Default                    | Used by                |
| ---------------- | -------------------------- | ---------------------- |
| `NODE_ENV`       | `development`              | backend                |
| `PORT`           | `3000`                     | backend                |
| `CORS_ORIGINS`   | `http://localhost:4200`    | backend                |
| `DB_HOST`        | `localhost`                | backend                |
| `DB_PORT`        | `5435`                     | backend + docker       |
| `DB_USERNAME`    | `syncra`                   | backend + docker       |
| `DB_PASSWORD`    | `syncra`                   | backend + docker       |
| `DB_NAME`        | `syncra`                   | backend + docker       |
| `VITE_API_URL`   | `http://localhost:3000/api`| frontend (Vite)        |

TypeORM runs with `synchronize: true` whenever `NODE_ENV !== 'production'`, so entity changes are reflected automatically in development. Turn this off and use migrations before shipping to production.

## Adding a shared library

```sh
npx nx g @nx/js:lib packages/shared --importPath=@syncra/shared
```

## Troubleshooting

- **`Bind for 0.0.0.0:5435 failed: port is already allocated`** — another service is using that port. Change `DB_PORT` in `.env` **and** in `docker-compose.yml` (the host side of the port mapping), then `npm run db:down && npm run db:up`.
- **Backend can't connect to Postgres** — make sure `npm run db:up` finished and `docker compose ps` reports the container as `healthy`.
- **Frontend gets CORS errors** — add the frontend origin to `CORS_ORIGINS` in `.env` (comma-separated) and restart the backend.

## Learn more

- [Nx documentation](https://nx.dev)
- [NestJS documentation](https://docs.nestjs.com)
- [TanStack Query](https://tanstack.com/query/latest)
- [TypeORM](https://typeorm.io)
