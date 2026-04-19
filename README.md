# Syncra

An Nx monorepo with a React 19 frontend and a NestJS backend backed by PostgreSQL (Docker).

## Stack

| Layer        | Tech                                                                |
| ------------ | ------------------------------------------------------------------- |
| Monorepo     | Nx 22 · **pnpm** workspaces                                         |
| Runtime      | **Node.js 24** (via nvm; pinned by `.nvmrc`)                        |
| Frontend     | React 19 · Vite · Tailwind CSS 3 · TanStack Query 5 · Vitest        |
| Backend      | NestJS 11 · TypeORM · `@nestjs/config`                              |
| Database     | PostgreSQL 16 (Alpine) running in Docker Compose                    |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full target architecture and [`plan/80-day-plan.md`](./plan/80-day-plan.md) for the build plan.

## Project layout

```
apps/
  frontend/        # React 19 + Vite + Tailwind + TanStack Query
  backend/         # NestJS + TypeORM
packages/          # shared libraries (empty for now)
plan/              # 80-day build plan
docker-compose.yml # Postgres 16 service
pnpm-workspace.yaml
.nvmrc             # pins Node 24
.env               # local env values (gitignored)
.env.example       # copy this to .env
```

## Requirements

- **Node.js 24** — installed via [nvm](https://github.com/nvm-sh/nvm). The `.nvmrc` in the repo pins the version.
- **pnpm 10+** — activated via Corepack (ships with Node). No manual install.
- **Docker** with Docker Compose v2 (Docker Desktop on macOS/Windows is fine).

## One-time setup

```sh
# 1. use the Node version pinned by .nvmrc
nvm install        # reads .nvmrc and installs Node 24 if not already present
nvm use            # activates Node 24 for this shell

# 2. enable Corepack (ships with Node 24) and activate pnpm
corepack enable
corepack prepare pnpm@latest --activate

# 3. install dependencies
pnpm install

# 4. create your local env file
cp .env.example .env
```

Review `.env` and adjust credentials/ports if needed. The default DB host port is **5435** (the container's own 5432 is mapped to host 5435 to avoid clashing with an already-running Postgres on `5432`). Change `DB_PORT` in both `.env` and `docker-compose.yml` if you prefer a different port.

## Running the apps

Start the services in separate terminals (or run the combined `dev` script).

```sh
# Terminal 1 — Postgres
pnpm db:up              # start Postgres in the background
pnpm db:logs            # (optional) follow logs
pnpm db:down            # stop and remove the container

# Terminal 2 — Backend (NestJS)
pnpm backend            # → http://localhost:3000/api

# Terminal 3 — Frontend (React + Vite)
pnpm frontend           # → http://localhost:4200

# Or run frontend + backend together
pnpm dev
```

Quick health check once the backend is up:

```sh
curl http://localhost:3000/api/health
# → {"status":"ok","uptime":...}
```

## Everyday commands

```sh
# build
pnpm nx build frontend
pnpm nx build backend

# test
pnpm nx test frontend
pnpm nx test backend

# lint / typecheck
pnpm nx lint frontend
pnpm nx lint backend
pnpm nx typecheck backend

# run any target on any project
pnpm nx <target> <project>

# run the same target across several projects
pnpm nx run-many -t build -p frontend,backend

# visualise the project graph
pnpm nx graph
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
pnpm nx g @nx/js:lib packages/shared --importPath=@syncra/shared
```

## Troubleshooting

- **`Bind for 0.0.0.0:5435 failed: port is already allocated`** — another service is using that port. Change `DB_PORT` in `.env` **and** in `docker-compose.yml` (the host side of the port mapping), then `pnpm db:down && pnpm db:up`.
- **Backend can't connect to Postgres** — make sure `pnpm db:up` finished and `docker compose ps` reports the container as `healthy`.
- **Frontend gets CORS errors** — add the frontend origin to `CORS_ORIGINS` in `.env` (comma-separated) and restart the backend.
- **Wrong Node version** — run `nvm use` in the repo root; it reads `.nvmrc`.
- **`pnpm` not found** — run `corepack enable && corepack prepare pnpm@latest --activate`.
- **`Ignored build scripts` warning after a dependency change** — new packages need their postinstall scripts allowlisted in `package.json` under `pnpm.onlyBuiltDependencies`.

## Learn more

- [Architecture doc](./ARCHITECTURE.md)
- [80-day build plan](./plan/80-day-plan.md)
- [Nx documentation](https://nx.dev)
- [pnpm workspaces](https://pnpm.io/workspaces)
- [NestJS documentation](https://docs.nestjs.com)
- [TanStack Query](https://tanstack.com/query/latest)
- [TypeORM](https://typeorm.io)
