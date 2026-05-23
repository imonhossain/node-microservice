# Day 0 — Implementation

> macOS-first. Linux notes inline. Windows: use WSL 2 + Ubuntu and follow the Linux paths.

## 0. Pre-flight

```sh
# macOS only — Xcode command-line tools
xcode-select --install || true
sw_vers                          # macOS version
uname -m                         # arm64 (Apple Silicon) or x86_64
```

---

## 1. Homebrew (macOS)

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew --version
```

Linux: skip; use your distro's package manager.

---

## 2. nvm + Node 24

```sh
brew install nvm

# zsh shell init
mkdir -p ~/.nvm
cat >> ~/.zshrc <<'EOF'
export NVM_DIR="$HOME/.nvm"
[ -s "$(brew --prefix nvm)/nvm.sh" ] && \. "$(brew --prefix nvm)/nvm.sh"
[ -s "$(brew --prefix nvm)/etc/bash_completion.d/nvm" ] && \. "$(brew --prefix nvm)/etc/bash_completion.d/nvm"
EOF
source ~/.zshrc

nvm install 24
nvm alias default 24
nvm use 24

node --version                   # v24.x
```

---

## 3. npm — verify it ships with Node 24

```sh
node --version            # v24.x
npm --version             # 10.x (bundled with Node 24)
```

If `npm` is missing your Node install is broken; reinstall via `nvm install 24`.

---

## 4. Docker Desktop

Download: https://www.docker.com/products/docker-desktop/

After install, in **Docker Desktop → Settings → Resources**:
- Memory: **8 GB** (12 GB if you have ≥ 32 GB host RAM)
- CPUs: **4**
- Disk image size: **64 GB**
- Apple Silicon: enable **Use Virtualization framework** + **VirtioFS**

Verify:

```sh
docker --version                 # 24+
docker compose version
docker run --rm hello-world
```

---

## 5. Other CLIs (eager set)

```sh
# Source control + GitHub
brew install git gh

# Postgres client
brew install libpq
echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
psql --version

# Secrets
brew install sops age

# General
brew install jq yq httpie

# Optional: install lazy-set now if you prefer one-shot
# brew install kubernetes-cli helm k3d linkerd argocd
```

Linux: `apt install -y git gh postgresql-client jq yq httpie age && curl -L … sops`.

Verify:

```sh
git --version
gh --version
psql --version
sops --version
age --version
jq --version
yq --version
http --version
```

---

## 6. Git global config

```sh
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
git config --global init.defaultBranch main
git config --global pull.rebase true
git config --global push.autoSetupRemote true
git config --global core.editor "code --wait"      # or "vim", "nano"
git config --global rebase.autoStash true
```

Verify:

```sh
git config --global --list
```

---

## 7. SSH key for GitHub

```sh
test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -C "you@example.com" -f ~/.ssh/id_ed25519 -N ""
eval "$(ssh-agent -s)"

# macOS: store passphrase in Keychain
cat >> ~/.ssh/config <<'EOF'
Host github.com
  AddKeysToAgent yes
  UseKeychain yes
  IdentityFile ~/.ssh/id_ed25519
EOF
chmod 600 ~/.ssh/config

ssh-add --apple-use-keychain ~/.ssh/id_ed25519 2>/dev/null || ssh-add ~/.ssh/id_ed25519

# Upload public key to GitHub
gh auth login                    # follow prompts; pick SSH
gh ssh-key add ~/.ssh/id_ed25519.pub --title "$(hostname)"

ssh -T git@github.com            # "Hi <username>! You've successfully authenticated"
```

---

## 8. Create the repo on GitHub + clone

If you want a brand-new project (skip if your `syncra/` already exists):

```sh
gh repo create syncra --private --clone --description "Syncra — modular monolith SaaS learning project"
cd syncra
```

Verify:

```sh
gh repo view --web
git remote -v
```

---

## 9. Bootstrap the Nx workspace

From inside an empty `syncra/` directory (or use `npx` to create one):

```sh
# Creates a new Nx workspace named "syncra" with no preset (we add apps manually)
npx create-nx-workspace@latest syncra \
  --preset=ts \
  --packageManager=npm \
  --nxCloud=skip \
  --formatter=none \
  --linter=none

cd syncra
```

> If you already have a workspace (this repo), skip this step.

---

## 10. Declare workspaces + engines

`package.json`:

```jsonc
{
  "name": "@syncra/source",
  "version": "0.0.0",
  "private": true,
  "license": "MIT",
  "engines": {
    "node": ">=24.0.0",
    "npm":  ">=10.0.0"
  },
  "workspaces": [
    "apps/*",
    "libs/*",
    "packages/*"
  ],
  "scripts": {
    "format":     "biome format --write .",
    "lint":       "biome check .",
    "lint:ci":    "biome ci .",
    "typecheck":  "nx run-many -t typecheck",
    "build":      "nx run-many -t build",
    "graph":      "nx graph"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "nx": "^22.0.0",
    "tsx": "^4.21.0",
    "typescript": "~5.6.0"
  }
}
```

> **No separate workspace file.** npm reads the `workspaces` array directly from the root `package.json`. One source of truth — no extra YAML to keep in sync.

`.nvmrc`:

```
24
```

Install:

```sh
npm install
```

---

## 11. Add Nx plugins

```sh
npm install --save-dev @nx/js @nx/nest @nx/react @nx/vite @nx/eslint
```

---

## 12. Scaffold apps

```sh
# api — NestJS HTTP service
npx nx g @nx/nest:app api --directory=apps/api --tags=type:app,scope:api --skipFormat

# realtime — NestJS standalone (Hocuspocus host)
npx nx g @nx/nest:app realtime --directory=apps/realtime --tags=type:app,scope:realtime --skipFormat

# workers — NestJS standalone (NATS / Temporal consumers)
npx nx g @nx/nest:app workers --directory=apps/workers --tags=type:app,scope:workers --skipFormat

# frontend — React + Vite SPA
npx nx g @nx/react:app frontend --directory=apps/frontend --bundler=vite --routing=true --style=tailwind --tags=type:app,scope:frontend --skipFormat
```

Quick sanity check — each app should serve / build:

```sh
npx nx build api
npx nx build frontend
```

---

## 13. Scaffold the shared `contracts` lib

```sh
npx nx g @nx/js:lib contracts --directory=libs/contracts --tags=type:lib,scope:shared --bundler=tsc --unitTestRunner=vitest --skipFormat
npm install zod -w @syncra/contracts
```

The lib's name should resolve to `@syncra/contracts`. Update its `package.json` if needed:

```jsonc
{ "name": "@syncra/contracts" }
```

Probe import:

```sh
echo "import { z } from 'zod'; export const Hello = z.object({ msg: z.string() });" \
  > libs/contracts/src/lib/hello.ts
npx nx typecheck contracts
```

---

## 14. `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "incremental": true,
    "composite": true,
    "declaration": true,
    "declarationMap": true
  }
}
```

> If Nx generated this with weaker settings, tighten it now. Tightening later means fixing every existing file.

---

## 15. Biome configuration

```sh
npx biome init
```

Replace `biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "files": {
    "ignore": [
      "**/dist/**",
      "**/.nx/**",
      "**/coverage/**",
      "**/node_modules/**",
      "package-lock.json"
    ]
  },
  "organizeImports": { "enabled": true },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all" }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": { "noUnusedVariables": "warn", "noUnusedImports": "warn" },
      "style": { "useConst": "error", "useTemplate": "warn" },
      "suspicious": { "noExplicitAny": "warn" }
    }
  }
}
```

Verify:

```sh
npx biome ci .                # exits 0 on a clean tree
npx biome check --write .     # auto-fix
```

---

## 16. `.editorconfig`

```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false

[Makefile]
indent_style = tab
```

---

## 17. `.gitignore`

```gitignore
# Dependencies
node_modules

# Build output
dist/
out-tsc/
.nx/cache/
.nx/workspace-data/
*.tsbuildinfo

# Test
coverage/

# IDE
.idea/
.vscode/*
!.vscode/extensions.json
!.vscode/settings.json

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*

# Env
.env
.env.local
.env.*.local
!.env.example

# Generated graph
graph.json
graph.html

# Docker volumes
pgdata/
minio/
```

---

## 18. `.env.example`

```sh
# Database (Day 1)
DATABASE_URL=postgresql://syncra:syncra@localhost:6432/syncra
APP_DATABASE_URL=postgresql://app_user:app_user@localhost:6432/syncra

# Cache & queue
REDIS_URL=redis://localhost:6379

# Messaging
NATS_URL=nats://localhost:4222

# Search
MEILI_URL=http://localhost:7700
MEILI_MASTER_KEY=dev-master-key

# Object store
S3_ENDPOINT=http://localhost:9200
S3_ACCESS_KEY=syncra
S3_SECRET_KEY=syncra-secret
S3_BUCKET=syncra-dev

# Email (dev)
SMTP_URL=smtp://mailpit:1025

# Telemetry
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Feature flags
UNLEASH_URL=http://localhost:4242/api
UNLEASH_API_TOKEN=dev:default.unleash-insecure-api-token
```

---

## 19. VS Code recommendations

`.vscode/extensions.json`:

```json
{
  "recommendations": [
    "biomejs.biome",
    "nrwl.angular-console",
    "bradlc.vscode-tailwindcss",
    "ms-azuretools.vscode-docker",
    "eamodio.gitlens",
    "yoavbls.pretty-ts-errors",
    "EditorConfig.EditorConfig",
    "Gruntfuggly.todo-tree"
  ]
}
```

`.vscode/settings.json`:

```json
{
  "editor.defaultFormatter": "biomejs.biome",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "quickfix.biome": "explicit",
    "source.organizeImports.biome": "explicit"
  },
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true,
  "files.eol": "\n",
  "files.insertFinalNewline": true,
  "files.trimTrailingWhitespace": true,
  "[markdown]": { "files.trimTrailingWhitespace": false }
}
```

---

## 20. Documentation scaffolding

```sh
mkdir -p docs/adr docs/journal docs/runbooks docs/design
```

`docs/adr/template.md`:

```markdown
---
status: proposed
date: YYYY-MM-DD
deciders: imon
---

# NNNN — Short title

## Context and Problem Statement

What forces are at play? What's the question we're answering?

## Considered Options

- Option A
- Option B
- Option C

## Decision Outcome

Chosen: **Option X**, because …

## Consequences

Good:
- ...

Bad:
- ...

## More Information

Links, related ADRs, follow-ups.
```

`docs/adr/0000-record-architecture-decisions.md`:

```markdown
---
status: accepted
date: 2026-05-03
deciders: imon
---

# 0000 — Record architecture decisions

## Context

Non-trivial architectural decisions need to be discoverable years later. Code
shows *what*; ADRs show *why*.

## Decision

We use the MADR 4 template. Files live in `docs/adr/NNNN-kebab-title.md`.
Numbering is sequential. Status is one of `proposed | accepted | superseded |
deprecated | rejected`. Superseded ADRs link to their successor.

## Consequences

- One ADR per non-trivial decision; targeting ≥ 17 by Day 80.
- Reviews of architectural changes happen on the ADR PR, not on code PRs.
```

`docs/journal/README.md`:

```markdown
# Journal

One file per active build day: `docs/journal/YYYY-MM-DD.md`.

## Format

```
# YYYY-MM-DD

## What I built
- ...

## What surprised me
- ...

## Open questions
- ...

## Tomorrow
- ...
```

Aim for 5 minutes max. The compounding return is in the consistency, not the depth.
```

`docs/runbooks/README.md`:

```markdown
# Runbooks

Operational guides for "something is on fire". Filled out in Week 12 once
production-realistic failure modes are known.
```

---

## 21. SOPS + age keypair

```sh
mkdir -p ~/.config/sops/age
test -f ~/.config/sops/age/keys.txt || age-keygen -o ~/.config/sops/age/keys.txt
chmod 600 ~/.config/sops/age/keys.txt
PUBLIC_AGE_KEY=$(grep '# public key:' ~/.config/sops/age/keys.txt | awk '{print $4}')
echo "$PUBLIC_AGE_KEY"
```

Repo-root `.sops.yaml`:

```yaml
creation_rules:
  - path_regex: ^infra/sops/.*\.enc\.(yaml|json|env)$
    age: AGE_PUBLIC_KEY_HERE      # paste the value of $PUBLIC_AGE_KEY
```

```sh
mkdir -p infra/sops
sed -i.bak "s|AGE_PUBLIC_KEY_HERE|$PUBLIC_AGE_KEY|" .sops.yaml && rm .sops.yaml.bak

# Smoke test: encrypt + decrypt a dummy secret
echo "FOO=bar" > infra/sops/test.enc.env
sops --encrypt --in-place infra/sops/test.enc.env
grep -q ENC infra/sops/test.enc.env && echo "encrypted OK"
sops --decrypt infra/sops/test.enc.env
rm infra/sops/test.enc.env
```

---

## 22. GitHub Actions CI

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm

      - run: npm ci

      - name: Lint (Biome)
        run: npx biome ci .

      - name: Typecheck
        run: npx nx run-many -t typecheck

      - name: Build
        run: npx nx run-many -t build
```

> `npm ci` is the CI-mode install: it bails if `package-lock.json` is out of sync with `package.json`. Always use it on CI; never `npm install`.

---

## 23. README

`README.md`:

```markdown
# Syncra

A learning-grade, multi-tenant SaaS app demonstrating event-driven modular-monolith
architecture. See `ARCHITECTURE.md` for the design and `plan/80-day-plan.md` for the build path.

## Quickstart

```sh
nvm use                 # Node 24
npm install            # install workspace deps
make up                 # boot infrastructure (Day 1)
npx nx run-many -t serve   # start the apps
```

## Layout

```
apps/        # deployable services (api, frontend, realtime, workers)
libs/        # shared libraries (contracts, db-kit, ...)
docs/        # ADRs, runbooks, journal, design notes
infra/       # docker-compose configs, k8s charts, SOPS secrets
plan/        # day-by-day build plan
```
```

---

## 24. First commit + push

```sh
git add .
git commit -m "chore: day 0 — bootstrap workspace, tooling, CI, ADR/journal scaffolding"
git push
gh pr create --title "Day 0: workspace bootstrap" --body "Scaffolds Nx workspace with apps (api, frontend, realtime, workers), shared lib (contracts), Biome, strict TS, ADR + journal templates, SOPS rule, CI."
gh pr checks
```

---

## 25. Done-criteria checklist

```sh
node --version          # v24.x
npm --version           # 10.x (bundled with Node 24)
docker --version
git --version
gh --version
psql --version
sops --version
age --version

npm install                          # clean
npx biome ci .                  # exit 0
npx nx run-many -t typecheck         # exit 0
npx nx run-many -t build             # exit 0

ls apps/api apps/frontend apps/realtime apps/workers
ls libs/contracts
ls docs/adr docs/journal docs/runbooks docs/design
test -f docs/adr/template.md && echo OK
test -f docs/adr/0000-record-architecture-decisions.md && echo OK
test -f .sops.yaml && grep -q "$(grep 'public key' ~/.config/sops/age/keys.txt | awk '{print $NF}')" .sops.yaml && echo OK
test -f .github/workflows/ci.yml && echo OK
gh pr checks                           # CI green
```

---

## 26. Common Day-0 errors and fixes

| Symptom                                                    | Cause                                      | Fix                                                                          |
| ---------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `nvm: command not found` after install                     | Shell rc not sourcing nvm                  | `source ~/.zshrc` (or open a new terminal)                                   |
| `npm: command not found`                                   | Node install incomplete                    | `nvm install 24 && nvm use 24` (npm ships with Node)                          |
| `WARN Unsupported engine: wanted: node>=24` on `npm install` | Wrong Node in this shell                   | `nvm use` (reads `.nvmrc`)                                                   |
| `permission denied (publickey)` from `git push`            | SSH key not added to GitHub or agent       | `gh ssh-key add ~/.ssh/id_ed25519.pub` and `ssh-add --apple-use-keychain ~/.ssh/id_ed25519` |
| `npm install` writes a different lockfile every run        | Concurrent edits to `package.json` from different machines | Commit `package-lock.json`; coordinate dep changes through PRs                |
| `nx: command not found`                                    | Trying to run nx globally                  | Always `npx nx ...` from repo root                                            |
| Biome formats Nx-generated files differently than Nx       | Two formatters fighting                    | Pass `--skipFormat` to every Nx generator; let Biome own formatting           |
| `gh auth login` browser flow stalls                        | SSH agent picked the wrong key              | `gh auth login --web --git-protocol ssh` and select your existing key         |
| `sops --encrypt` says "no matching creation rule"          | `.sops.yaml` `path_regex` doesn't match     | Use `^infra/sops/.*\.enc\.(yaml\|json\|env)$` and place file accordingly      |
| CI fails "lockfile mismatch"                               | Local `npm install` updated lockfile, not committed | `git add package-lock.json && git commit -m "chore: lockfile" && git push`     |
| `npm ci` fails locally too                                  | Lockfile + package.json out of sync         | Delete `node_modules` + `package-lock.json`, run `npm install`, commit the new lockfile |

---

## 27. Tear down (only if you want to start over)

```sh
# Wipe local artefacts; keeps git history
rm -rf node_modules .nx dist out-tsc coverage *.tsbuildinfo

# Delete the Nx Cloud connection (if you ever connect)
# nx reset

# Nuclear: re-clone from scratch
cd ..
rm -rf syncra
gh repo clone <you>/syncra
cd syncra && npm install
```
