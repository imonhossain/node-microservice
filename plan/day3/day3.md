# Day 3 — Authentication: Identity, OAuth, and Cookies
*A learner's guide. We'll go slow.*

---

## Hello again 👋

Two days ago you booted infrastructure. Yesterday you made the database refuse to leak data between tenants. Today you give that database a person.

Until now, every query has been *scoped to a workspace*, but **nobody is signed in**. There's no Alice, no Bob — just rows. Today's job:

> Alice opens her browser, clicks "Sign in with Google", and ends up signed in to Syncra. Our backend knows she is Alice. We can prove it on every request.

By the end of today, you'll be able to say:

> "When the browser sends a request, my backend cryptographically verifies *who* sent it, looks them up in the `users` table (or creates them on the fly), and either responds with their data or returns 401. That works in 50ms with zero database round-trips for the verify step."

That's a real auth system. Let's build it.

---

## 1. The problem (a tiny story)

Imagine three browsers each making a request:

```
   GET /api/me
   Cookie: session=eyJhbGciOiJIUzI1...     ← Alice's
```

```
   GET /api/me
   Cookie: session=eyJhbGciOiJIUzI1...     ← Mallory's (a forged cookie!)
```

```
   GET /api/me
   (no cookie)                              ← someone not signed in
```

Three jobs your backend must do:

1. **Read** the cookie.
2. **Verify** the cookie was actually issued by us (not Mallory's photoshop).
3. **Map** the cookie to a real user in our database.

Alice → 200, profile JSON.
Mallory → 401.
No-cookie → 401.

The whole rest of the day is the mechanics of those three steps.

---

## 2. Big picture (what we're building today)

```
   ┌──────────────────────────────┐
   │ Browser  (apps/frontend)      │
   │   /login page  •  useMe()     │
   └──────────────┬───────────────┘
                  │ 1. clicks "Sign in with Google"
                  ▼
   ┌──────────────────────────────┐
   │ Backend  (apps/backend)       │
   │   /api/auth/* (Auth.js)       │   ← redirects to Google
   └──────────────┬───────────────┘
                  │
                  ▼
            ┌──────────┐
            │  Google  │  ← user signs in there
            └─────┬────┘
                  │ 2. redirects back with ?code=...
                  ▼
   ┌──────────────────────────────┐
   │ Backend  /api/auth/callback   │
   │   Auth.js exchanges code for  │
   │   tokens; sets a signed       │
   │   cookie in the response      │
   └──────────────┬───────────────┘
                  │ 3. browser follows redirect to /
                  ▼
   ┌──────────────────────────────┐
   │ Browser sends every request   │
   │ with the signed cookie        │
   └──────────────┬───────────────┘
                  │
                  ▼
   ┌──────────────────────────────┐
   │ Backend middleware            │
   │   ─ reads cookie               │
   │   ─ verifies signature         │
   │   ─ JIT-creates `users` row    │
   │     for first-time users       │
   │   ─ attaches `req.user`        │
   └──────────────────────────────┘
```

Today's pieces, by file:

```
apps/backend/src/
├── auth/
│   └── auth.config.ts              ← Auth.js config (provider, secret, callbacks)
├── modules/identity/
│   ├── identity.module.ts          ← Nest module
│   ├── identity.controller.ts      ← /api/me, /api/auth/sign-out
│   ├── identity.service.ts         ← JIT user lookup/creation
│   └── identity.middleware.ts      ← reads cookie, attaches req.user
└── main.ts                          ← mounts Auth.js Express middleware

apps/frontend/src/
├── routes/
│   ├── _auth/login.tsx             ← "Sign in with Google" button
│   └── _app/index.tsx              ← post-login shell
└── hooks/
    └── use-me.ts                    ← TanStack Query hook
```

---

## 3. The 5 new ideas you'll meet today

| Idea                       | One-line summary                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------- |
| **OAuth 2.0 / OIDC**       | A handshake that lets a third party (Google) tell us *who you are* without giving us your password. |
| **JWT cookie session**     | A tiny signed string we put in a cookie; reading it tells us who's signed in, no DB hit. |
| **JWKS** (related)         | A list of public keys an IdP publishes so anyone can verify *its* signed tokens.       |
| **Cookie flag discipline** | The four flags (`__Host-`, `Secure`, `HttpOnly`, `SameSite`) that turn a cookie from "footgun" to "safe". |
| **JIT provisioning**       | First time we see a user, we create their `users` row on the fly.                      |

Let's meet them properly.

---

### 3.1 OAuth 2.0 — the "let Google tell you who I am" handshake

Imagine you walk into a bar. The bouncer wants to verify your age. You don't hand him your house keys, your birth certificate, and your social security number — you hand him a **driver's license**. The DMV (a third party) attests to your age; the bouncer trusts the DMV.

OAuth is exactly that, for software. Google is the DMV. Our backend is the bouncer. The user's password never touches us.

Here's the dance, in 6 steps:

```
1. User clicks "Sign in with Google" on our /login page
2. We redirect them to: accounts.google.com/o/oauth2/v2/auth?client_id=...&scope=read:user
3. Google asks them: "Hi Alice, do you want to let Syncra read your profile?"
4. Alice clicks "Authorize"
5. Google redirects back to: localhost:3000/api/auth/callback/google?code=abc123
6. Our backend exchanges that code (server-to-server) for an access token + user profile
   └─ now we know "this person is alice@gmail with id 12345"
```

Step 6 is invisible to the user. The browser just sees: redirect to Google → redirect back → logged in.

> **OIDC** (OpenID Connect) is OAuth 2.0 + a thin layer that returns an **ID token** (a JWT containing user info) at step 5. Google IS an OIDC provider — so at step 5 we get a signed `id_token` with the user's `sub`, `email`, and `name` already inside, plus an access token for fetching `picture`. Auth.js handles all of this; we just configure the provider.

We don't write any of step 1–6 by hand. **Auth.js v5** does the dance for us. We configure it: "use Google, here's our client id and secret". Auth.js handles redirects, code exchange, ID-token verification (against Google's JWKS — see §3.3), and ends up calling our callback with the Google user profile.

---

### 3.2 JWT cookie session — the "you're still you" sticker

After step 6, the user is signed in. But how does the *next* request prove it?

Two options the industry has tried:

#### Option A — server-side sessions (the old way)

Backend stores `session_id → user_id` in Redis. Sets a cookie with `session_id`. Every request: read cookie → look up Redis → know who you are.

Works. Adds a Redis hit per request. Hard to scale across regions.

#### Option B — JWT cookie (what we use)

Backend signs a small JSON object with a secret key:

```json
{ "sub": "12345", "email": "alice@gmail.com", "exp": 1730000000 }
```

…with HMAC-SHA256, producing:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSIsImVtY...
```

That's the JWT. We stuff it in a cookie. Every subsequent request:
- Read cookie.
- Verify signature using the secret. (No DB hit.)
- The decoded payload tells us who the user is.

**Why JWT wins for us**:
- Stateless verification — any backend instance can verify, no shared session store.
- Microsecond-fast. No Redis round-trip.
- Survives PgBouncer / load balancers transparently.

**The trade-off**: revocation is harder. A signed JWT is valid until it expires. If you sign Alice out at the IdP, the cookie still works for, say, 24 hours. Solutions: short expiries + refresh, or a revocation list (rare in practice).

For us — and for most SaaS apps — short-lived JWT cookies are the right answer.

---

### 3.3 JWKS — the "anyone can verify the IdP" trick

When a third party (Google, Auth0, Clerk) issues JWTs, *they* sign them with their private key. *We* need to verify them with the matching public key. So every OIDC provider publishes its public keys at a well-known URL. Google's lives here:

```
https://www.googleapis.com/oauth2/v3/certs
```

JWKS = "JSON Web Key Set". The verifying backend:
1. Fetches that URL once.
2. Caches the keys in memory.
3. On token verify, picks the right key by `kid` (key ID) and checks the signature.
4. Refreshes the cache periodically (keys rotate).

**Auth.js handles this for us.** When Google sends back an `id_token` at step 5 of the OAuth flow, Auth.js fetches Google's JWKS, verifies the signature, caches the keys, and refreshes when the `kid` rotates. You won't see JWKS code in our repo — but it's running every time you sign in.

The cookie we then *give the browser* is a separate JWT, signed with **our own** `AUTH_SECRET` (HMAC, not JWKS). Two JWTs, two trust models: the IdP's (asymmetric, verified via JWKS) for proving identity at sign-in time, ours (symmetric, verified with `AUTH_SECRET`) for session continuity on every request after.

Day 41 (public API) you'll write JWKS verification yourself for inbound webhook signatures — that's where the pattern becomes hands-on.

---

### 3.4 Cookie flags — turning a footgun into a safe

A cookie is just a string the server tells the browser to remember. By default, it's leaky and dangerous. Four flags fix that.

Imagine a cookie like:

```
Set-Cookie: __Host-syncra-session=eyJhbGciOiJIUzI1...; Secure; HttpOnly; SameSite=Lax; Path=/
```

Each piece does work:

#### `__Host-` prefix

A magic prefix that browsers respect. A `__Host-` cookie:
- Can only be set if `Secure` is also set.
- Must have `Path=/` (the whole site).
- **Cannot have a `Domain` attribute** — locks it to the exact host.

The win: a subdomain attacker (`evil.syncra.io`) cannot overwrite or read your cookie. The cookie is welded to *this exact origin*.

#### `Secure`

The cookie is only sent over **HTTPS**. In dev (localhost), browsers make an exception so this still works.

Without `Secure`, an attacker on the same Wi-Fi could sniff the cookie over plain HTTP.

#### `HttpOnly`

JavaScript on your page **cannot read** the cookie via `document.cookie`. Period.

Without it, a single XSS bug (some `dangerouslySetInnerHTML` typo, a vulnerable npm package) lets the attacker steal every signed-in user's cookie.

This is the single most important flag. **Every** auth cookie should be HttpOnly. Always.

#### `SameSite=Lax`

The cookie is **not** sent on cross-site requests, except top-level navigation (clicking a link). This prevents most CSRF attacks: `evil.com` cannot make your browser POST to `syncra.io/api/delete-everything` with your cookie attached.

Three values:
- `Strict` — never sent cross-site. Breaks "click a link in an email and land logged in".
- `Lax` — sent on top-level GETs only. Sane default.
- `None` — always sent (requires `Secure`). Only for embedded SaaS widgets.

We use `Lax`. Almost everyone should.

#### Quick mental rule

> Every auth cookie ships with `__Host-` + `Secure` + `HttpOnly` + `SameSite=Lax`. If even one is missing, that's a P1 bug. Treat them as **always-on**, not "configurable".

---

### 3.5 JIT provisioning — handling the first-time user

When Alice signs in for the first time, our `users` table doesn't have her yet. We have two choices:

**Option A — pre-create users out-of-band.**
Admin pre-creates accounts; users sign in to existing rows. Common in B2B / enterprise. We'll support this in Week 11 (SCIM provisioning).

**Option B — JIT (just-in-time) provisioning.**
First sign-in creates the row automatically. Standard for B2C and self-serve B2B. Today we use this.

The pattern:

```ts
// inside the auth middleware, after we know the Google profile
let user = await db.query.users.findFirst({
  where: eq(users.externalId, googleProfile.id),
});

if (!user) {
  [user] = await db.insert(users).values({
    externalId: googleProfile.id,
    email:      googleProfile.email,
    displayName: googleProfile.name,
    avatarUrl:  googleProfile.avatarUrl,
  }).returning();

  // Day 4 will emit `user.registered` here, via outbox.
}

req.user = user;
```

Three things to note:

1. **`external_id` is the IdP's `sub`** (Google's user identifier — a 21-digit numeric string). Never trust the email — emails change; `sub` doesn't.
2. **The lookup happens once per request** (cached in `req.user`). The verify-the-cookie part is microsecond-fast; the DB lookup adds ~1ms.
3. **First-time provisioning emits an event** (Day 4+) so downstream systems (audit, analytics) know there's a new user. Today we just create the row.

---

## 4. The full request flow (end-to-end)

After all the pieces are wired, here's what happens when Alice opens `/w/acme/tasks` after she's already signed in:

```
   1. Browser sends:        GET /w/acme/tasks
                            Cookie: __Host-syncra-session=eyJ...
                                │
   2. Auth.js middleware:    decodes the JWT, verifies HMAC sig
                             → { sub: '12345', email: 'alice@gmail.com' }
                                │
   3. Identity middleware:   db.query.users.findFirst(externalId='12345')
                             → user row { id: 'a1b...', email, displayName, ... }
                             req.user = user
                                │
   4. Workspace middleware:  read :slug from URL → look up workspace → assert
                             user is a member → req.workspace = workspace
                             (Day 4)
                                │
   5. Endpoint:              withCtx({workspaceId, userId}, async (tx) =>
                                tx.select().from(tasks))
                                │
   6. Postgres + RLS:        only returns Acme tasks
                                │
   7. Response:              [...tasks]
```

For a sign-in attempt:

```
   1. Browser hits:          GET /api/auth/signin/google
                                │
   2. Auth.js redirects to:  accounts.google.com/o/oauth2/v2/auth?...
                                │
   3. User signs in / consents on Google
                                │
   4. Google redirects to:   /api/auth/callback/google?code=abc123
                                │
   5. Auth.js exchanges code (server-to-server) for an access token
                                │
   6. Auth.js calls googleapis.com/oauth2/v3/userinfo with the access token
                             → { id, email, name, avatar_url }
                                │
   7. Auth.js issues a signed JWT cookie
                             Set-Cookie: __Host-syncra-session=eyJ...
                                │
   8. Auth.js redirects to:  / (the SPA home route)
                                │
   9. Frontend calls:        GET /api/me  (with the new cookie)
                             → { id, email, displayName, ... }
                                │
   10. App renders the workspace.
```

---

## 5. Where Auth.js stops and our code starts

This is the most important slide. Auth.js is a library. It does some things; we own the rest.

| Job                                                | Done by                              |
| -------------------------------------------------- | ------------------------------------ |
| Render `/api/auth/signin/google` redirect           | Auth.js                              |
| Handle `/api/auth/callback/google`                  | Auth.js                              |
| Exchange auth code for tokens                       | Auth.js                              |
| Fetch Google user profile                           | Auth.js                              |
| Sign + set the session JWT cookie                   | Auth.js                              |
| Set cookie flags (`__Host-`, etc.)                  | Auth.js (we configure)               |
| Verify the cookie on each request                   | Auth.js helper (our middleware uses it) |
| Decide what to put *in* the JWT payload             | **Our `jwt` callback** (we own)      |
| Look up the user row in our DB                      | **Our `IdentityService`** (we own)   |
| Create the user row on first sign-in                | **Our `IdentityService`** (we own)   |
| Expose `/api/me` endpoint                           | **Our `IdentityController`** (we own) |
| Sign the user out                                   | Auth.js (we trigger)                 |
| Render `/login` and `Sign in with Google` button    | **Our frontend** (we own)            |
| Decide where to redirect after login                | Auth.js (we configure)               |

The seam is clean: Auth.js handles cryptographic and protocol bits; we handle our domain.

---

## 6. Common mistakes to watch for

| You do this                                                | What goes wrong                                                  | The fix                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Use `localStorage.setItem('token', ...)` to store the JWT  | Any XSS reads the token; refresh logic gets ugly                  | JWT in an `HttpOnly` cookie. JS literally cannot read it. Always.                       |
| Skip `__Host-` because "I don't have subdomains"            | Day someone deploys a marketing site to `www.syncra.io`           | Use `__Host-` from day one. It costs nothing.                                          |
| Use `SameSite=None` to "make the OAuth flow work"          | CSRF target. Cookie sent on *every* cross-site request            | Default to `Lax`. Only loosen it if you have a real cross-site embed need.             |
| Trust `email` as the user identifier                        | Users change email addresses; you split the same person in two   | Always key off `external_id` (= IdP `sub`). Email is metadata.                         |
| Skip JIT provisioning, fail with 404 on first sign-in       | Brand-new user can never get past `/login`                        | Create the row in the auth callback. Even if you don't have a name yet.                |
| Sign the JWT with a short, hard-coded `secret`              | One leaked git commit and *every* user's cookie is forgeable     | `AUTH_SECRET=$(openssl rand -hex 32)`, put it in `.env`, never commit.                 |
| Forget `trustHost: true` in dev                              | Auth.js refuses to issue cookies because it can't verify the host | In dev, `trustHost: true`. In prod, set `AUTH_URL=https://syncra.example`.            |
| Mix `localhost:3000` (frontend) and `localhost:3001` (backend) for cookies | Cross-origin → cookies blocked → "I'm signed in but `/me` returns 401" | Use a Vite proxy so both speak the same origin                              |

---

## 7. What you ship today

By the end of the day:

- [ ] Auth.js v5 mounted on the backend at `/api/auth/*`.
- [ ] Google OAuth client created; client id + secret in `.env`.
- [ ] `apps/backend/src/modules/identity` with controller, service, middleware.
- [ ] `GET /api/me` returns the signed-in user; 401 otherwise.
- [ ] `POST /api/auth/signout` clears the cookie.
- [ ] Cookie has `__Host-syncra-session` name with `Secure`, `HttpOnly`, `SameSite=Lax`.
- [ ] First-time sign-in JIT-creates a row in `users`.
- [ ] Frontend `/login` page with "Sign in with Google" button.
- [ ] Frontend `useMe()` hook + 401-redirect to `/login`.
- [ ] **ADR 0002** committed: *Auth.js v5 vs Clerk vs roll-your-own*.

---

## 8. Verify it works (the demo)

```sh
# 1) Start everything
make up                                    # Day-1 infra (still running, hopefully)
npx nx serve backend                      # NestJS, port 3000
npx nx serve frontend                     # Vite, port 4200 (proxies /api → 3000)

# 2) Sign-in flow (browser)
open http://localhost:4200/login
# click "Sign in with Google" → Google asks → click Authorize → bounced to /

# 3) Verify the cookie was set
# DevTools → Application → Cookies → __Host-syncra-session
#   Secure: ✓, HttpOnly: ✓, SameSite: Lax, Path: /

# 4) Verify the API knows you
curl -s http://localhost:4200/api/me \
  -H "Cookie: __Host-syncra-session=$(your_cookie_value)"
# { "id": "...", "email": "alice@example.com", "displayName": "Alice", ... }

# 5) Verify the row landed in Postgres
psql 'postgresql://syncra:syncra@localhost:6432/syncra' \
  -c "SELECT id, email, external_id FROM users;"
# 1 row

# 6) Sign out
curl -X POST http://localhost:4200/api/auth/signout
# response clears the cookie

# 7) Verify protected
curl -s http://localhost:4200/api/me   # → 401 Unauthorized
```

---

## 9. Today's mental shifts (the lessons)

1. **You don't store passwords. Ever.** OAuth means Google (or another OIDC IdP like Auth0, Clerk) is the password authority. Your backend never sees plaintext passwords, never hashes them, never gets called for password resets. That's a huge attack surface gone.
2. **Auth = identity + session.** Identity is "who are you" (proven once, by OAuth). Session is "you're still you" (proven on every request, by cookie). They're separate problems with separate solutions. Today we built both halves.
3. **Cookie flags are the four-screw mounting bracket.** `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`. Anything less and your auth cookie is a footgun. Memorize this; cite it in code review.
4. **JIT provisioning is the user lifecycle's first step.** Today: row created on first OAuth callback. Day 4: that creates a workspace. Week 11: SCIM keeps it in sync with corporate IdPs. The whole pipeline starts here.

---

## 10. Journal prompts (5 minutes)

1. Before today, what was your mental model of "logged in"? Has anything shifted?
2. Why is `HttpOnly` more important than `Secure`, in your view? When would the priorities flip?
3. If a teammate proposed using `localStorage` for the JWT to "make mobile easier", what would you say?

---

## 11. What we did NOT do today (and why)

- **Email/password auth.** Bigger attack surface, password resets, breached-password checks. We delegate to Google. Day 11+ if we ever need it.
- **Multi-factor auth.** Google provides it for free at their layer. Good enough until we add internal accounts.
- **SAML / SSO.** Week 11. Enterprise-grade IdP integration.
- **Refresh tokens.** Auth.js handles short-lived sessions internally. We don't expose refresh tokens to the SPA.
- **Anonymous sessions.** Every workspace needs a real owner from row 1. No anonymous browsing today.
- **Casbin / role enforcement.** Tomorrow (Day 4). Today only proves *who* you are; tomorrow decides *what you can do*.
- **`workspace.create` endpoint.** Day 4. Today's `/me` returns user but no workspaces yet — that's normal.

The point of today: **after Day 3, every request that reaches your endpoints already knows who the user is.** The next 77 days build on top of that.

---

## 12. Want to read more?

- Auth.js v5 docs — https://authjs.dev
- Auth.js Express adapter — https://authjs.dev/reference/express
- OAuth 2.0 explained visually — https://aaronparecki.com/oauth-2-simplified/
- OWASP Cookie Security — https://owasp.org/www-community/controls/SecureCookieAttribute
- Mozilla cookie reference — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie
- The `__Host-` prefix — https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies#cookie_prefixes
- JWKS and key rotation — https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-key-sets

---

Good Day 3. Tomorrow you wire identity to workspaces and finally have the full sign-up → invite → first task flow we drew on Day 0.
