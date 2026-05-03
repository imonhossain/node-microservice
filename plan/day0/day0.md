# Day 0 — Pre-flight & Project Setup (Learning Guide)

> Goal of today: a brand-new laptop becomes a Syncra-ready development machine, and an empty directory becomes a Git-tracked Nx monorepo with the skeletons of three apps (`api`, `frontend`, `realtime`), one shared library (`contracts`), an ADR folder, a journal folder, a CI workflow that lints + builds on every PR, and a working secrets pipeline. Day 1 should boot infrastructure on top of *this* — not "set things up while figuring out infra".
>
> Day 0 is the day where you spend a few hours installing tools you'll touch every day for 80 days. Slow down. Get it right.

---

## 0. Orientation — what "Day 0" buys you

There are two kinds of setup pain:

1. **Slow pain**: spending 30 minutes installing tools today, methodically, with verifications.
2. **Fast pain**: skipping setup and discovering on Day 14 that your editor's TypeScript doesn't match CI's, that your secrets are in plaintext in `.env`, that your commit history shows your personal email on a "professional" repo, or that nobody told you that `pnpm install` failed silently because of a Corepack mismatch.

Day 0 is slow pain by choice. Everything you do today is one of:

- A **toolchain** decision (Node, pnpm, Docker) → pick once, pin it, never think again.
- A **workspace** decision (Nx, libs vs apps, contracts boundary) → defines what Day 1+ slots into.
- A **process** decision (ADRs, journal, conventional commits, branch hygiene) → cheap to set up; very expensive to retrofit.

```
         ┌──────────── you, today ────────────┐
         │ install · pin · verify · git init  │
         └──────────────┬─────────────────────┘
                        │
       ┌────────────────▼────────────────┐
       │ toolchain      | workspace      │
       │ ─ nvm, Node 24 │ ─ Nx monorepo  │
       │ ─ Corepack +   │ ─ apps/* libs/* │
       │   pnpm 10      │ ─ contracts    │
       │ ─ Docker       │ ─ Biome        │
       │ ─ git, gh, ssh │ ─ tsconfig base │
       │ ─ infra CLIs   │ ─ scripts dir  │
       └────────────────┴────────────────┘
                        │
            ┌───────────▼───────────┐
            │ process / hygiene      │
            │ ─ ADRs (docs/adr/)     │
            │ ─ journal (docs/...)   │
            │ ─ Conventional Commits  │
            │ ─ .editorconfig + .vscode │
            │ ─ CI: lint + build      │
            │ ─ SOPS + age secrets    │
            └────────────────────────┘
```

Day 1 won't redo any of this. It only *uses* it.

---

## 1. The toolchain — what to install and why

### 1.1 The version manager (`nvm`)

Don't install Node from the official `.pkg`. Don't `brew install node`. Both pin you to one version forever. Use a version manager — `nvm` is the de-facto standard.

- `.nvmrc` in the repo says **which** Node version this project expects.
- `nvm use` reads it. The shell switches Node, system-wide-PATH-wise, just for this terminal.
- Different projects on the same laptop can use different Node versions without conflict.

**Why not `n` / `volta` / `fnm`**:
- `n` writes into `/usr/local` — collides with brew, requires `sudo`.
- `volta` and `fnm` are good — pick `nvm` only because it's what 80% of tutorials and onboarding guides assume.

### 1.2 Node.js — which LTS

Node has a 6-month release cadence. Even-numbered majors become **LTS** (long-term support). LTS = security patches for 30 months.

- Node **22** went LTS Oct 2024.
- Node **24** went LTS Oct 2025 — current at the time of this plan.

We pin to **Node 24** because:
- First-class `fetch`, `AbortController`, Web Streams in the standard library.
- Native TS type-stripping (experimental) for ad-hoc scripts.
- Permission model (`--permission`) — finer-grained than "everything or nothing".
- Stable test runner (`node:test`) good enough for ad-hoc scripts without Jest/Vitest.

### 1.3 Corepack + pnpm

Skip `npm install -g pnpm`. **Corepack** ships *inside* Node and lets `package.json` declare which package manager + version this project expects:

```jsonc
{
  "packageManager": "pnpm@10.33.0"
}
```

When any teammate runs `pnpm install` for the first time, Corepack downloads exactly that version of pnpm. No "I'm on pnpm 8, you're on pnpm 10, why does our lockfile keep flipping" arguments.

**Why pnpm over npm/yarn**: see day1.md §1 — content-addressable store, strict by default, fast, workspaces are first-class. Standard for monorepos in 2026.

### 1.4 Docker Desktop

You already touched Docker on Day 1. Day 0 is where you tune it:

- **≥ 8 GB RAM** allocated to the Docker VM (we run 16 containers concurrently).
- **≥ 4 CPUs**.
- **≥ 50 GB disk free** in the Docker disk image.
- Enable **Use Virtualization framework** + **VirtioFS** on macOS — meaningfully faster bind mounts for the kind of compose stack we'll run.

Docker Desktop is gratis for personal use; if your employer is large enough, you may need Rancher Desktop or OrbStack instead — both are drop-in replacements for the `docker` CLI.

### 1.5 The other CLIs

The 80-day plan touches a lot of tools. Install them upfront so you're not yak-shaving on Day 36. Group by *when you'll need them* — install the eager ones now, the lazy ones the week before.

| CLI                      | Used for                          | When you need it    | Install eagerly? |
| ------------------------ | --------------------------------- | ------------------- | ---------------- |
| `git`, `gh`              | Source control + GitHub           | Day 0               | Yes              |
| `psql` (`libpq`)         | Postgres client                   | Day 1               | Yes              |
| `nats` CLI               | NATS pub/sub from terminal        | Day 1 (via container) / Day 10 (host) | Optional |
| `temporal` CLI           | Temporal workflow ops             | Day 25              | Lazy             |
| `mc` (MinIO client)      | S3-compatible bucket ops          | Day 30              | Lazy             |
| `kubectl`                | Kubernetes                        | Day 57              | Lazy             |
| `helm`                   | K8s charts                        | Day 58              | Lazy             |
| `k3d` (or `kind`)        | Local Kubernetes                  | Day 57              | Lazy             |
| `linkerd`                | Service mesh                      | Day 63              | Lazy             |
| `argocd`                 | Argo CD GitOps                    | Day 62              | Lazy             |
| `sops`, `age`            | Secret encryption                 | Day 0 (set up keys) | **Yes**          |
| `jq`, `yq`, `httpie`     | JSON / YAML / HTTP from shell     | Constant            | Yes              |

Eager today: `git`, `gh`, `psql` (libpq), `sops`, `age`, `jq`, `yq`, `httpie`. The rest can wait until the relevant week.

### 1.6 Why install via Homebrew (and pin nothing)

We let brew float. This is a learning project, not a banking system. If brew bumps `kubectl` next month, that's fine — most CLIs are backwards-compatible enough. Pinning matters for *language runtimes* (Node) and *package managers* (pnpm) because they touch `node_modules` reproducibility. CLIs are throwaway.

---

## 2. Git, GitHub, and your identity

### 2.1 Global git config

Three things you set globally, once:

```sh
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --global init.defaultBranch main
git config --global pull.rebase true              # never accidentally merge-commit on pull
git config --global push.autoSetupRemote true     # `git push` works on first push without `-u origin`
```

The default branch goes to `main` because that's the modern default — no more `master`.

### 2.2 SSH vs HTTPS for GitHub

Use SSH. HTTPS auth requires the `gh` CLI keepalive or token storage; SSH is once-and-done.

- Generate an Ed25519 key (smaller, faster, modern): `ssh-keygen -t ed25519 -C "you@example.com"`.
- Upload the public key to GitHub Settings → SSH keys.
- Test: `ssh -T git@github.com`.

### 2.3 Conventional Commits

Adopt a commit-message convention from Day 0 — too late to retrofit later.

```
feat(api): add workspace invitation endpoint
fix(frontend): correct timezone offset on task due dates
chore(deps): bump drizzle-orm to 0.36.1
docs(adr): 0001 drizzle over prisma
refactor(workers): split outbox relay into module
```

Why bother on a solo project: it makes `git log --oneline` actually readable, lets you regenerate a changelog mechanically (Week 12's release tag), and primes your muscle memory for any team you join.

### 2.4 Branch hygiene

- Work on feature branches: `feat/day-2-drizzle-rls`, never on `main`.
- Open a PR against `main` — even if it's a one-author repo. The PR template forces you to articulate the change and triggers the CI workflow.
- Squash on merge so `main`'s history is the journal of *features shipped*, not the journal of *commits made*.

---

## 3. Why a monorepo (and why Nx)

### 3.1 The "many repos" trap

The naive structure:

```
syncra-frontend/   ← repo 1
syncra-api/        ← repo 2
syncra-realtime/   ← repo 3
syncra-contracts/  ← repo 4
```

Now:
- A schema change requires PRs across 2–3 repos.
- Type changes in `contracts` need a publish-to-npm step before consumers see them.
- CI runs every test for every repo on every change.
- Refactoring across boundaries means coordinating multiple PRs.
- Local dev means cloning, linking, and remembering the order.

### 3.2 The monorepo

```
syncra/
├── apps/
│   ├── api/
│   ├── frontend/
│   ├── realtime/
│   └── workers/
├── libs/
│   ├── contracts/        # shared Zod schemas, tRPC routers, event types
│   ├── db-kit/
│   └── ui-kit/
└── ...
```

One repo. One install. One PR can change a contract and its 3 consumers atomically. CI runs only what's affected (more on that next).

### 3.3 Nx vs alternatives

| Tool        | Strength                                           | Weakness                                              |
| ----------- | -------------------------------------------------- | ----------------------------------------------------- |
| **pnpm workspaces alone** | Zero magic, just symlinks                | No task graph, no cache, no "affected"                |
| **Lerna**   | Originally made this category                       | Maintenance has been inconsistent; less interesting after pnpm absorbed most of its features |
| **Turborepo** | Beautifully simple, great cache, great DX         | Plugin ecosystem narrower than Nx; less opinionated    |
| **Rush**    | Microsoft-grade, very mature                        | Heavy, opinionated config, smaller community           |
| **Nx**      | Plugin per framework, generators, computation cache, "affected", visualisation | Heavier than Turborepo; more concepts to learn |

We pick **Nx** because:

- **Plugins per framework** — `@nx/nest`, `@nx/react`, `@nx/vite`, `@nx/eslint` give you batteries-included generators for the common case.
- **`nx affected`** — only rebuild/test what's downstream of changed files. Vital once the repo has 4 apps × 10 libs.
- **Computation cache** — local first, Nx Cloud optional later — second `nx build` is instant.
- **`nx graph`** — visualises the dependency graph in a browser, indispensable for refactors.
- **`nx generate`** — `nx g @nx/nest:lib auth-kit` writes a correctly-wired NestJS library; you don't fight folder layout.
- **TS Project References by default** — incremental TS compilation across libs, no "why is type-checking so slow" three months in.

The trade-off: Nx introduces concepts (executors, generators, project graph, named inputs, targets) you'll spend half a day learning. Worth it for the compounding return over 80 days.

### 3.4 The `apps/` vs `libs/` boundary

```
apps/   ← runtime (deployable). Each one becomes a Docker image / process.
libs/   ← reusable code. Cannot import from apps. Can only be imported, not run.
```

Rules (enforced by Nx's `module-boundaries` rule):
- An app may import any lib it depends on.
- A lib may import other libs but **never** an app.
- Frontend-only libs can never be imported by a backend app and vice versa (tag-based).
- `libs/contracts` is the *only* place cross-service types and Zod schemas live.

This is the architectural single-most-important boundary. Keep it religiously and refactors stay easy. Break it once and the dependency graph turns into spaghetti.

---

## 4. Linting & formatting — Biome

ESLint + Prettier is the historical default. It works. It's also: two tools, two configs, two cache directories, two plugin ecosystems, two CI runs, two things that disagree on edge cases.

**Biome** (formerly Rome) is a single Rust binary that does both:

- Lints (≈ 200+ rules; covers most ESLint recommended + react-hooks + tsc-eslint subset).
- Formats (Prettier-compatible defaults, *much* faster).
- Imports organisation, dead-code detection.
- Single config file (`biome.json`).
- 10–20× faster than ESLint+Prettier on a real repo.

We use **Biome as primary**. ESLint stays around only for a few plugin rules Biome doesn't yet have (e.g. `eslint-plugin-tailwindcss` for class ordering).

The historic argument *for* ESLint — "the plugin ecosystem" — is shrinking as Biome adds rules every release. By the time we'd need to relitigate this, Biome will have closed any remaining gap.

---

## 5. TypeScript baseline — strict from Day 0

`tsconfig.base.json` carries the settings every other tsconfig extends:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true
  }
}
```

The two opinions worth defending:

- **`noUncheckedIndexedAccess: true`** — `arr[i]` becomes `T | undefined`. Catches every "I assumed this was defined but it wasn't" bug at compile time. The first month it feels punishing; from month two it's invisible.
- **`verbatimModuleSyntax: true`** — every `import` whose only purpose is types must say `import type`. Forces clean ESM/CJS boundaries.

Don't lower these later because they're "annoying". They're a tax that prevents one whole class of production bug.

---

## 6. Editor configuration — make it shareable

### 6.1 `.editorconfig`

The lowest-common-denominator config that every editor reads:

```ini
root = true

[*]
indent_style       = space
indent_size        = 2
end_of_line        = lf
charset            = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[Makefile]
indent_style = tab
```

This is what stops "you used spaces but I use tabs" PRs.

### 6.2 `.vscode/settings.json` + `extensions.json`

Commit a recommended-extensions list (`dbaeumer.vscode-eslint`, `biomejs.biome`, `esbenp.prettier-vscode`, etc.) and project settings (format-on-save with Biome, default formatter, etc.). VS Code prompts new contributors to install the extensions on open.

Don't commit `.vscode/launch.json` unless it's project-generic — debug configs leak personal paths.

---

## 7. Documentation conventions

Set up the folders Day 0 so they exist when you need them. Empty folders aren't tracked by git, so commit a `.gitkeep` or a placeholder.

```
docs/
├── adr/                            # architecture decision records (MADR 4)
│   ├── template.md                 # copy this when writing a new ADR
│   └── 0000-record-architecture-decisions.md   # the meta-ADR
├── journal/                        # daily journal — one .md per active day
│   └── README.md                   # explains the format
├── runbooks/                       # operational runbooks (filled Week 12)
│   └── README.md
└── design/                         # design notes / RFCs (saga design, etc.)
```

### 7.1 ADRs (Architecture Decision Records)

Every non-trivial decision lives in `docs/adr/NNNN-title.md` using the **MADR 4** template. A non-trivial decision is anything you'd later want to know *why* about — not "I picked port 3000 for the dev server", but "Drizzle over Prisma".

Per the 80-day plan you're targeting **17–20 ADRs by Day 80**. The "what" of each is in the code; the "why" is in the ADR.

### 7.2 Journal

5-minute end-of-day write-up: what shipped, what surprised you, one open question. The compounding effect of 80 of these is huge — they double as portfolio material at Week 12.

---

## 8. Secrets baseline — SOPS + age

You will eventually store secrets (database URLs, API keys, signing keys) in git. Plain `.env` files are how teams accidentally publish their AWS keys. **SOPS** + **age** is the modern, simple answer.

- **age** = small, modern public-key encryption. Generate one keypair per developer + one per environment.
- **SOPS** = wrapper that encrypts/decrypts YAML, JSON, ENV files in-place using age.
- `.sops.yaml` at the repo root says "encrypt anything in `infra/sops/*.enc.yaml` with these public keys".
- Encrypted files are committed. Plaintext keys never touch git.

We don't *use* secrets today; we set up the keypair so when Day 1's `.env.example` becomes Day 41's "encrypted prod values", the path is already paved.

---

## 9. CI baseline — GitHub Actions skeleton

Even on a solo repo, set up CI Day 0. Without it, a PR that "looks fine" can still ship broken code; with it, you get the muscle memory of "if CI is red, don't merge".

The Day 0 workflow is small — three jobs:

1. **Lint** — `pnpm exec biome ci .`
2. **Type-check** — `pnpm nx run-many -t typecheck`
3. **Build** — `pnpm nx run-many -t build`

We add tests on Day 2 (when there's something to test). We add `nx affected` on Day 14 (when the graph is large enough that "run everything" is slow).

Cache `node_modules` via `actions/setup-node` + `pnpm` cache config. First run takes 90s; subsequent runs ~30s. Don't optimise further today.

---

## 10. The Nx workspace — what gets created today

```
syncra/
├── apps/
│   ├── api/                    # NestJS HTTP service (skeleton; populated Day 3+)
│   ├── frontend/               # React 19 + Vite SPA (skeleton; populated Day 6+)
│   ├── realtime/               # NestJS standalone for Hocuspocus (Day 15+)
│   └── workers/                # NestJS standalone for NATS / Temporal (Day 10+)
├── libs/
│   └── contracts/              # @syncra/contracts — shared Zod schemas
├── docs/
│   ├── adr/
│   ├── journal/
│   ├── runbooks/
│   └── design/
├── infra/                      # filled Day 1+
│   └── sops/                   # encrypted secrets per env (Day 41+)
├── scripts/                    # check-infra.ts (Day 1) and friends
├── .github/
│   └── workflows/ci.yml        # lint + typecheck + build
├── .vscode/                    # recommended extensions, format-on-save settings
├── .editorconfig
├── .gitignore
├── .nvmrc                      # "24"
├── biome.json                  # one config for lint + format
├── nx.json                     # Nx workspace config
├── package.json                # packageManager: pnpm@10.33.0
├── pnpm-workspace.yaml         # apps/* libs/* packages/*
├── tsconfig.base.json          # strict TS settings, project references
├── README.md
├── ARCHITECTURE.md             # already exists
└── CLAUDE.md                   # already exists
```

You won't write much code today. Apps are *scaffolded* by Nx generators with the minimum to compile and serve a "hello world". The point is that on Day 1 morning you `nx serve api`, see "Hello, world", and move on.

---

## 11. Today's deliverables

- [ ] All required CLIs installed and on PATH; `--version` checks documented in journal.
- [ ] Docker Desktop tuned (RAM, CPU, disk).
- [ ] Git global config + SSH key + `gh auth login`.
- [ ] GitHub repo created and pushed.
- [ ] `nvm install 24`, `.nvmrc` pinned.
- [ ] Corepack enabled + pnpm pinned via `packageManager`.
- [ ] Nx workspace bootstrapped with apps `api`, `frontend`, `realtime`, `workers`, lib `contracts`.
- [ ] `tsconfig.base.json`, `biome.json`, `.editorconfig`, `.gitignore`, `.nvmrc`, `.env.example` committed.
- [ ] `docs/adr/template.md` + `docs/adr/0000-record-architecture-decisions.md` committed.
- [ ] `docs/journal/README.md` committed.
- [ ] age keypair generated; `.sops.yaml` rule for `infra/sops/*.enc.yaml`.
- [ ] GitHub Actions `ci.yml` with lint + typecheck + build runs green on PR.
- [ ] `.vscode/extensions.json` and `.vscode/settings.json` committed.

---

## 12. Verify

```sh
# Toolchain
node --version              # v24.x
pnpm --version              # 10.x
docker --version            # 24+
git --version
gh --version
psql --version
sops --version
age --version

# Workspace
ls .nvmrc biome.json nx.json package.json pnpm-workspace.yaml tsconfig.base.json
ls apps/api apps/frontend apps/realtime apps/workers
ls libs/contracts
ls docs/adr docs/journal docs/runbooks
test -f docs/adr/template.md && echo OK
test -f docs/adr/0000-record-architecture-decisions.md && echo OK

# Sanity
pnpm install                # clean
pnpm exec biome ci .        # green
pnpm nx run-many -t typecheck   # green
pnpm nx run-many -t build       # green
pnpm nx graph --file=graph.json && echo OK     # graph emits

# CI
git push                    # opens PR; check Actions tab
```

---

## 13. Checkpoint — Day 0 done when

- [ ] `node --version` → `v24.x`, `pnpm --version` → `10.x`.
- [ ] `gh repo view` shows the repo.
- [ ] `pnpm install` is clean and uses the pinned `pnpm@10.33.0`.
- [ ] `pnpm nx run-many -t typecheck` and `-t build` both green.
- [ ] `pnpm exec biome ci .` exits 0.
- [ ] `nx graph` opens in the browser and shows your projects.
- [ ] CI on `main` is green; opening a PR runs the workflow.
- [ ] `age-keygen -y -o /dev/null < ~/.config/sops/age/keys.txt` returns a public key.
- [ ] `docs/adr/0000` and `docs/adr/template.md` are committed.

---

## 14. Journal prompt (end of day)

`docs/journal/<today>.md`. 2–3 sentences each:

1. Which tool's purpose did I understand best by the end of today, and which one's still murky?
2. If a friend wanted to bootstrap their own monorepo, what's the first thing I'd tell them about Nx that the docs underplay?
3. What's the one Day-0 corner I cut that I'm worried about retroactively paying for?

---

## 15. What we didn't do today — and why

- **No business code.** Day 1 brings up infrastructure, Day 2 ships the first schema. Today is *just* the runway.
- **No Docker compose stack.** Day 1 owns that.
- **No Drizzle / Postgres setup.** Day 2 owns that.
- **No Auth.js / Clerk.** Day 3 owns that.
- **No tests.** Vitest comes online with `libs/db-kit` on Day 2.
- **No frontend routes.** Day 6 wires TanStack Router.
- **No SOPS-encrypted values.** Just the keypair and the `.sops.yaml` rule. We *use* it from Day 41 onward.

The point of today is that Day 1 morning starts with `make up`, not with `brew install …`.

---

## 16. Further reading (skim, don't memorise)

- nvm — https://github.com/nvm-sh/nvm
- Corepack — https://nodejs.org/api/corepack.html
- pnpm — https://pnpm.io
- Nx — https://nx.dev
- Nx affected — https://nx.dev/concepts/affected
- Nx project graph — https://nx.dev/features/explore-graph
- Biome — https://biomejs.dev
- TypeScript strict — https://www.typescriptlang.org/tsconfig#strict
- MADR 4 — https://adr.github.io/madr/
- Conventional Commits — https://www.conventionalcommits.org
- SOPS — https://github.com/getsops/sops
- age — https://github.com/FiloSottile/age
- GitHub Actions — https://docs.github.com/actions

---

Good Day 0. Tomorrow you boot 16 containers in a single command.
