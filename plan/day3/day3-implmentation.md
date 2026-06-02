# Day 3 — Implementation

> Stack: Auth.js v5 + GitHub OAuth + NestJS (apps/backend) + React + Vite (apps/frontend) + `@syncra/db-kit` from Day 2.

## 0. Pre-flight

```sh
nvm use 24
node --version                              # v24.x
docker compose ps                           # Day-1 infra Up
brew install postgresql
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c '\dt'  # 4 tables + _drizzle_migrations
npm test -w @syncra/db-kit                 # 3 passing
```

---

## 1. Create a GitHub OAuth app

1. Go to https://github.com/settings/developers → **New OAuth App**.
2. Fill in:
   - **Application name**: `Syncra (dev)`
   - **Homepage URL**: `http://localhost:4200`
   - **Authorization callback URL**: `http://localhost:3000/api/auth/callback/github`
3. Save.
4. Click **Generate a new client secret**. Copy both values somewhere safe.

You now have:

```
GitHub Client ID:     Iv1.abc123...
GitHub Client Secret: ghp_xyz789...
```

---

## 2. Generate the Auth.js secret

Auth.js needs a 32-byte secret for signing cookies:

```sh
openssl rand -hex 32
# 1a2b3c... 64 hex chars
```

Save this for the next step.

---

## 3. Environment variables

`.env` at repo root (do NOT commit; `.env` is already in `.gitignore`):

```sh
# Auth.js
AUTH_SECRET=<paste the 32-byte hex from step 2>
AUTH_TRUST_HOST=true
AUTH_URL=http://localhost:3000

# GitHub OAuth
AUTH_GITHUB_ID=<your client id>
AUTH_GITHUB_SECRET=<your client secret>

# Database (already there from Day 2, but make sure)
DATABASE_URL=postgresql://syncra:syncra@localhost:6432/syncra
APP_DATABASE_URL=postgresql://app_user:app_user@localhost:6432/syncra
```

Update `.env.example` (committed, no secrets):

```sh
AUTH_SECRET=replace-with-openssl-rand-hex-32
AUTH_TRUST_HOST=true
AUTH_URL=http://localhost:3000
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=
DATABASE_URL=postgresql://syncra:syncra@localhost:6432/syncra
APP_DATABASE_URL=postgresql://app_user:app_user@localhost:6432/syncra
```

---

## 4. Install dependencies

```sh
# Backend deps (Auth.js + cookie parsing + jose for JWT verify)
npm install @auth/express @auth/core jose cookie-parser -w @syncra/backend
npm install --save-dev @types/cookie-parser -w @syncra/backend

# Backend uses db-kit for the users table (workspace dep — npm auto-symlinks siblings by name)
npm install @syncra/db-kit -w @syncra/backend

# Frontend: TanStack Query (we'll use it for /me)
npm install @tanstack/react-query -w @syncra/frontend
```

Verify:

```sh
grep -E '"@auth/express"|"@auth/core"|"jose"|"@syncra/db-kit"' apps/backend/package.json
grep -E '"@tanstack/react-query"' apps/frontend/package.json
```

---

## 5. Backend — Auth.js config

`apps/backend/src/auth/auth.config.ts`:

```ts
import GitHub from '@auth/express/providers/github';
import type { ExpressAuthConfig } from '@auth/express';

export const authConfig: ExpressAuthConfig = {
  trustHost: true,
  secret: process.env.AUTH_SECRET,

  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID!,
      clientSecret: process.env.AUTH_GITHUB_SECRET!,
    }),
  ],

  session: {
    strategy: 'jwt',
    maxAge: 60 * 60 * 24 * 7,            // 7 days
  },

  // In dev (http://localhost) we let Auth.js choose cookie names + flags.
  // It will use `authjs.session-token` over plain HTTP and auto-prefix
  // `__Secure-` / `__Host-` once you serve over HTTPS in production.
  // The dev-strict `__Host-syncra-session` configuration is below — flip it
  // on once you serve the SPA over HTTPS (Day 41+):
  //
  // cookies: {
  //   sessionToken: {
  //     name: '__Host-syncra-session',
  //     options: { httpOnly: true, sameSite: 'lax', path: '/', secure: true },
  //   },
  // },

  callbacks: {
    // Put what we need into the JWT payload.
    async jwt({ token, account, profile }) {
      if (account && profile) {
        // First sign-in: store the IdP details on the token.
        token.sub = String(profile.id ?? token.sub);
        token.email = profile.email ?? token.email;
        token.name = profile.name ?? token.name;
        token.picture = (profile as { avatar_url?: string }).avatar_url ?? token.picture;
        token.provider = account.provider;
      }
      return token;
    },

    // Shape the session object Auth.js exposes.
    async session({ session, token }) {
      if (token.sub) session.user = { ...session.user, id: token.sub };
      return session;
    },
  },

  pages: {
    signIn: '/login',
  },
};
```

> **Why `__Host-` works on localhost** even though it requires `Secure`: browsers treat `http://localhost` as a "secure context" exception. Same cookie config works in dev and prod.

---

## 6. Backend — Identity module

`apps/backend/src/modules/identity/identity.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
// Always import drizzle helpers (eq, and, sql, …) THROUGH db-kit to avoid the
// dual-package hazard (lib is ESM, backend is CJS; importing drizzle-orm
// directly produces two distinct SQL<unknown> types). See db-kit/src/index.ts.
import { db, schema, eq } from '@syncra/db-kit';

export type IdpProfile = {
  externalId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
};

@Injectable()
export class IdentityService {
  /**
   * JIT (just-in-time) user lookup.
   * Returns the existing users row, or creates one on first sign-in.
   */
  async getOrCreateUser(profile: IdpProfile) {
    const existing = await db.query.users.findFirst({
      where: eq(schema.users.externalId, profile.externalId),
    });
    if (existing) return existing;

    const [created] = await db
      .insert(schema.users)
      .values({
        externalId: profile.externalId,
        email: profile.email,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      })
      .returning();

    // Day 4 will publish `user.registered` here via the outbox pattern.
    return created;
  }
}
```

`apps/backend/src/modules/identity/identity.middleware.ts`:

```ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { getSession } from '@auth/express';
import type { NextFunction, Request, Response } from 'express';
import { authConfig } from '../../auth/auth.config';
import { IdentityService } from './identity.service';

declare module 'express' {
  interface Request {
    user?: Awaited<ReturnType<IdentityService['getOrCreateUser']>>;
  }
}

@Injectable()
export class IdentityMiddleware implements NestMiddleware {
  constructor(private readonly identity: IdentityService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const session = await getSession(req, authConfig);
    if (!session?.user) return next();             // anonymous; let the route decide

    const externalId = (session.user as { id?: string }).id;
    const email = session.user.email;
    if (!externalId || !email) return next();

    req.user = await this.identity.getOrCreateUser({
      externalId,
      email,
      displayName: session.user.name ?? null,
      avatarUrl: (session.user as { image?: string }).image ?? null,
    });
    next();
  }
}
```

`apps/backend/src/modules/identity/identity.controller.ts`:

```ts
import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

@Controller('api')
export class IdentityController {
  @Get('me')
  me(@Req() req: Request) {
    if (!req.user) throw new UnauthorizedException();
    const { id, email, displayName, avatarUrl, createdAt } = req.user;
    return { id, email, displayName, avatarUrl, createdAt };
  }
}
```

`apps/backend/src/modules/identity/identity.module.ts`:

```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { IdentityMiddleware } from './identity.middleware';

@Module({
  controllers: [IdentityController],
  providers: [IdentityService, IdentityMiddleware],
  exports: [IdentityService],
})
export class IdentityModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Run the identity middleware on every API route except auth itself.
    // Express 5 / path-to-regexp v8 requires named wildcards.
    consumer.apply(IdentityMiddleware).forRoutes('api/*path');
  }
}
```

Wire it into the root module — `apps/backend/src/app/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module';

@Module({
  imports: [IdentityModule],
})
export class AppModule {}
```

---

## 7. Backend — mount Auth.js Express handler

Auth.js's Express adapter is *not* a Nest controller; it's an Express middleware. We mount it before Nest takes over.

`apps/backend/src/main.ts`:

```ts
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { ExpressAuth } from '@auth/express';
import { AppModule } from './app/app.module';
import { authConfig } from './auth/auth.config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.use(cookieParser());

  // Auth.js handles every /api/auth/* route (signin, callback, signout, session).
  // It MUST be mounted before Nest's router so it owns those paths.
  // Express 5: mount as a path prefix (no bare `/*` — not valid in path-to-regexp v8).
  app.use('/api/auth', ExpressAuth(authConfig));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`API running on http://localhost:${port}`);
}

bootstrap();
```

> **Order matters.** `cookieParser` must run before `ExpressAuth` so cookies are parsed. `ExpressAuth` must be mounted before NestFactory's catch-all so `/api/auth/*` doesn't fall through to Nest's 404.

---

## 8. Frontend — Vite proxy + login + useMe

### 8.1 Proxy `/api` to the backend

This is the trick that makes cookies work without CORS pain. The frontend dev server forwards `/api/*` to the backend, so the browser sees one origin.

`apps/frontend/vite.config.ts` — add `server.proxy`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4200,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
        cookieDomainRewrite: 'localhost',
      },
    },
  },
});
```

### 8.2 The `useMe` hook

`apps/frontend/src/hooks/use-me.ts`:

```ts
import { useQuery } from '@tanstack/react-query';

export type Me = {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
};

async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/api/me', { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/api/me -> ${res.status}`);
  return (await res.json()) as Me;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
    staleTime: 30_000,
    retry: false,
  });
}
```

### 8.3 Login page

`apps/frontend/src/app/login.tsx`:

> **Auth.js v5 requires POST + CSRF** to initiate sign-in. An `<a href>` GET will throw `UnknownAction` on the server. Fetch the CSRF token first, then submit a form.

```tsx
import { useEffect, useState } from 'react';

export function LoginPage() {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/csrf', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { csrfToken: string }) => setCsrfToken(d.csrfToken))
      .catch(() => setCsrfToken(null));
  }, []);

  return (
    <div style={{ maxWidth: 360, margin: '120px auto', textAlign: 'center' }}>
      <h1>Sign in to Syncra</h1>
      <p style={{ color: '#666' }}>Use your GitHub account</p>
      <form method="post" action="/api/auth/signin/github" style={{ marginTop: 16 }}>
        <input type="hidden" name="csrfToken" value={csrfToken ?? ''} />
        <input type="hidden" name="callbackUrl" value="/" />
        <button
          type="submit"
          disabled={!csrfToken}
          style={{
            padding: '10px 20px',
            background: '#24292f',
            color: 'white',
            border: 0,
            borderRadius: 6,
            cursor: csrfToken ? 'pointer' : 'not-allowed',
            opacity: csrfToken ? 1 : 0.6,
          }}
        >
          Sign in with GitHub
        </button>
      </form>
    </div>
  );
}
```

### 8.4 Post-login shell + auth guard

`apps/frontend/src/app/app.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginPage } from './login';
import { useMe } from '../hooks/use-me';

const qc = new QueryClient();

function Shell() {
  const { data: me, isLoading } = useMe();

  if (isLoading) return <div>Loading…</div>;
  if (!me) return <LoginPage />;

  return (
    <div style={{ padding: 24 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {me.avatarUrl && (
          <img src={me.avatarUrl} alt="" width={40} height={40} style={{ borderRadius: '50%' }} />
        )}
        <div>
          <div style={{ fontWeight: 600 }}>{me.displayName ?? me.email}</div>
          <div style={{ color: '#666', fontSize: 14 }}>{me.email}</div>
        </div>
        <form method="post" action="/api/auth/signout" style={{ marginLeft: 'auto' }}>
          <button type="submit">Sign out</button>
        </form>
      </header>
      <main style={{ marginTop: 32 }}>
        <h2>You're signed in 🎉</h2>
        <p>Day 4 brings workspaces and invitations.</p>
      </main>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>
  );
}
```

(If your existing `app.tsx` differs — most generated Vite scaffolds have a different shape — adapt the Shell logic into wherever your top-level component is. The key bits are: `<QueryClientProvider>`, `useMe`, conditional render of `<LoginPage>` vs the authenticated shell.)

`apps/frontend/src/main.tsx` should already mount `<App />`. If not:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

---

## 9. Run it

```sh
# In one terminal — backend
npx nx serve backend
# wait for: "API running on http://localhost:3000"

# In another terminal — frontend
npx nx serve frontend
# wait for: "Local: http://localhost:4200/"
```

Open http://localhost:4200/ in a browser.

- You see the **Sign in with GitHub** button.
- Click it → redirected to GitHub → click **Authorize** → bounced back to `/`.
- The page now shows your name, email, and avatar.

---

## 10. Verify (paste-able commands)

### 10.1 Cookie shape (dev defaults)

Open browser DevTools → **Application → Cookies → http://localhost:4200**. You should see:

| Name                                | HttpOnly | Secure | SameSite | Path |
| ----------------------------------- | -------- | ------ | -------- | ---- |
| `authjs.session-token`              | ✓        | (–)    | Lax      | /    |
| `authjs.csrf-token`                 | ✓        | (–)    | Lax      | /    |
| `authjs.callback-url`               | ✓        | (–)    | Lax      | /    |

In dev (plain HTTP localhost) Auth.js skips the `Secure` flag and the `__Secure-`/`__Host-` prefixes; over HTTPS in prod it auto-adds both. `HttpOnly` and `SameSite=Lax` are always on — those are the non-negotiables.

### 10.2 The `/api/me` endpoint

```sh
# After signing in via the browser:
COOKIE=$(open browser → DevTools → Application → Cookies, copy authjs.session-token value)

curl -s "http://localhost:4200/api/me" \
  -H "Cookie: authjs.session-token=$COOKIE"
# {"id":"...","email":"...","displayName":"...","avatarUrl":"...","createdAt":"..."}

# Without cookie:
curl -i "http://localhost:4200/api/me"
# HTTP/1.1 401 Unauthorized
```

### 10.3 The user row landed in Postgres

```sh
psql 'postgresql://syncra:syncra@localhost:6432/syncra' \
  -c "SELECT id, email, external_id, display_name FROM users;"
# 1 row, your GitHub id + email
```

### 10.4 Sign-out clears the cookie

```sh
curl -i -X POST "http://localhost:4200/api/auth/signout" \
  -H "Cookie: authjs.session-token=$COOKIE"
# Look for a Set-Cookie header that clears the session
```

After signing out in the browser, refreshing `/api/me` returns 401.

### 10.5 Idempotent JIT

Sign out + sign back in with the same GitHub account. Confirm:

```sh
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c "SELECT count(*) FROM users;"
# Still 1 — second sign-in matched on external_id, didn't insert a duplicate
```

### 10.6 Different account creates a new row

If you have a second GitHub account, sign out and sign in with it. Run the count again — should be 2.

---

## 11. ADR 0002

`docs/adr/0002-auth-js-v5-vs-clerk.md`:

```markdown
---
status: accepted
date: 2026-05-04
deciders: imon
---

# 0002 — Auth.js v5 over Clerk and roll-your-own

## Context and Problem Statement

We need an authentication system that:

- Supports OAuth 2.0 with multiple providers (GitHub today; Google, SAML later).
- Issues secure cookie sessions with `__Host-` + `HttpOnly` + `SameSite=Lax`.
- Plays well with NestJS (Express under the hood).
- Lets us own the `users` table and JIT-provision rows on first sign-in.
- Fits a self-hosted, no-vendor-lock-in posture for the learning project.

## Considered Options

- **Auth.js v5 (`@auth/express`)** — open-source, framework-agnostic since v5.
- **Clerk** — hosted SaaS; one-line integration; JWKS-verified JWTs.
- **Roll-your-own with `arctic` + `jose`** — minimal libraries, deepest learning, most code.
- **`passport` + `passport-github`** — venerable, decoupled, but old-school.

## Decision Outcome

Chosen: **Auth.js v5**.

- Standard for the JS ecosystem in 2026; transferable knowledge.
- The Express adapter mounts cleanly in a Nest app.
- Built-in cookie discipline (we configure `__Host-`, `HttpOnly`, `SameSite=Lax`).
- We own the JIT-provisioning seam via the `jwt` callback.
- No vendor lock-in. We can swap providers (GitHub → Google → SAML) without changing how sessions work.

Rejected:

- **Clerk** — adds a hosted dependency and monthly cost. Easier setup, but the learning value of running our own auth is exactly what this project is for. Re-evaluate at scale.
- **Roll-your-own** — too easy to mis-handle CSRF / state / PKCE; not worth the bug surface for a learning project.
- **passport** — superseded; `@auth/express` is the modern equivalent.

## Consequences

Good:
- One auth lib for all providers; adding Google later is a 5-line change.
- Cookies are configured once and reused everywhere.
- JIT logic lives in our domain code, not behind a library wall.

Bad:
- Auth.js v5 outside Next.js is still beta-quality. Some edge cases (e.g. CSRF on form-encoded sign-out) require careful config.
- We pay a small "wire it into Nest" tax: Express middleware mounted in `main.ts`, plus a Nest middleware to hydrate `req.user`.
```

---

## 12. Done-criteria checklist

```sh
test -f docs/adr/0002-auth-js-v5-vs-clerk.md && echo OK
grep -E '"@auth/express"' apps/backend/package.json
grep -E "GitHub" apps/backend/src/auth/auth.config.ts
test -f apps/backend/src/modules/identity/identity.module.ts
test -f apps/frontend/src/hooks/use-me.ts
npx nx run backend:typecheck
npx nx run frontend:typecheck
# Manual: sign in via browser → /api/me works → sign out → /api/me 401
```

---

## 13. Common errors and fixes

| Symptom                                                              | Cause                                                               | Fix                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/api/me` returns `<!doctype html>` (Vite's index.html)               | Vite proxy not active — `proxy` is at the top level instead of nested under `server` | Nest it: `server: { port: 4200, proxy: { '/api': { target: 'http://localhost:3000' } } }`. **Restart Vite** — config changes don't HMR |
| Auth.js page says "Server error - There is a problem with the server configuration" + backend logs `[auth][error] UnknownAction` | Sign-in button uses `<a href>` (GET) but Auth.js v5 requires `<form method="post">` + CSRF | Fetch `/api/auth/csrf` on mount; POST `signin/github` with hidden `csrfToken` + `callbackUrl` fields |
| GitHub returns "redirect_uri does not match"                          | Callback URL doesn't match GitHub OAuth app config                   | In GitHub OAuth app settings: `http://localhost:3000/api/auth/callback/github` exactly             |
| `MissingSecret` / `JWTSessionError`                                   | `AUTH_SECRET` empty or unset                                        | `openssl rand -hex 32` → put in `.env` → restart backend                                            |
| Auth.js logs "untrusted host"                                         | `trustHost` not set in dev                                          | `trustHost: true` in `auth.config.ts`, plus `AUTH_TRUST_HOST=true` in `.env`                        |
| Cookie set but `/api/me` returns 401 from the SPA                     | Frontend on different origin → cookie not sent                      | Use the Vite proxy: `/api → http://localhost:3000`. Don't `fetch('http://localhost:3000/api/me')` directly |
| `Set-Cookie` is missing the `Secure` flag                             | Cookie option was overridden                                        | Make sure `cookies.sessionToken.options.secure = true` and you're not behind an HTTPS-stripping proxy |
| `req.user` is undefined inside controllers                            | `IdentityMiddleware` not configured for that route                  | `forRoutes('api/(.*)')` matches everything under `/api`. Adjust glob if needed                      |
| `__Host-` rejected by browser                                         | Missing `Secure` or has a `Domain` attribute or `Path != '/'`        | All three rules apply: `secure: true`, `path: '/'`, no `domain`                                     |
| Repeated sign-ins create new user rows each time                      | JIT lookup keyed on `email`, not `external_id`                      | `findFirst({ where: eq(users.externalId, ...) })`. `external_id` is the IdP `sub`                   |
| Sign-out form does nothing                                            | CSRF / form-encoding mismatch                                       | Use `<form method="post" action="/api/auth/signout">` (Auth.js handles a CSRF token internally)     |
| `localhost:3000` and `localhost:4200` both setting cookies            | Two origins, two cookies, one confused dev                          | Always go through Vite (`http://localhost:4200`); never fetch the backend port directly             |
| `npm install` fails with `@auth/express not found`                   | The package is published as `@auth/express` (scoped)                 | `npm install @auth/express @auth/core -w @syncra/backend`                            |
| `TypeError: Missing parameter name at 6` on `app.use('/api/auth/*', …)` | Express 5's path-to-regexp v8 rejects bare `*` wildcards            | `app.use('/api/auth', ExpressAuth(authConfig))` — mount as a prefix, no `/*`        |
| `LegacyRouteConverter` warning on `forRoutes('api/(.*)')`           | Same Express 5 wildcard restriction in Nest middleware              | Use a named wildcard: `forRoutes('api/*path')`                                       |
| `Type 'SQL<unknown>' is not assignable to type 'SQL<unknown>'`       | Dual-package hazard: backend (CJS) loads drizzle-orm separately from db-kit (ESM) | Import drizzle helpers THROUGH `@syncra/db-kit`: `import { db, schema, eq } from '@syncra/db-kit'`. Never `from 'drizzle-orm'` in app code |
| `Module '@syncra/db-kit' has no exported member 'db'` (in IDE only) | Lib's `package.json` doesn't expose the `@org/source` condition required by base tsconfig's `customConditions`, or relative imports lack `.js` extensions | (a) Add conditional exports to db-kit/package.json; (b) every relative import inside db-kit ends in `.js` even for `.ts` files (ESM rule) |

---

## 14. Tear down (for debugging only)

```sh
# Forget the dev session entirely
psql 'postgresql://syncra:syncra@localhost:6432/syncra' -c "DELETE FROM users;"

# Restart backend to reload .env if you changed AUTH_SECRET
# (Existing cookies become unverifiable → users get 401 → re-login)
```
