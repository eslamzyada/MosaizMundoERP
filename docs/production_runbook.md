# Production & Operations Runbook

How to perform the operational tasks that live *outside* the code: rotating keys,
wiring the identity webhook, connecting the POS, and the pre-production checklist.
None of these are bugs — they're the steps between "safe to develop" and "safe to
put real money and users through it".

> Project: **MosaizMundoERP** · Supabase ref `swuvksmyxkajaebaagkk` (region ap-northeast-2).
> The project signs access tokens with **ES256** (asymmetric); there is no shared
> HS256 secret. Confirmed via the JWKS: `…/auth/v1/.well-known/jwks.json`.

---

## 0. First, what actually needs doing (and what doesn't)

| Item | Reality | Action |
| --- | --- | --- |
| "Rotate the leaked anon key" | The anon key is a **publishable** key — public by design, shipped in every client. Its appearance anywhere is not a compromise. | Optional hygiene (§1). |
| "Rotate the leaked JWT secret" | Nothing leaked. Tokens are signed by an **ES256 private key held inside Supabase**, never exposed. `backend/.env`'s `SUPABASE_JWT_SECRET` is a random value used only by the Jest tests. | Optional hygiene (§2). |
| Identity webhook secret | Not a Supabase-managed value to "extract" — it's a secret **you** invent and set on both sides. Also needs a **public** backend URL. | Real work (§3), deploy-time. |
| Wire the POS to Supabase | **Already done and verified** — see §4. | Done. |

---

## 1. Rotating the API keys (anon / publishable)

Docs: <https://supabase.com/docs/guides/api/api-keys>

The client apps use the **anon (publishable)** key. The backend does **not** use it
at all, so rotating it never touches `backend/.env`.

**Legacy vs modern.** Your project currently exposes both:
- `anon` — legacy, JWT-based. Legacy keys (`anon` + `service_role`) must be
  **rotated together**, and rotation invalidates the old ones immediately.
- `sb_publishable_…` — modern publishable key, **rotates independently** and is the
  recommended one for new apps. Migrating to it is the cleaner long-term move.

**Steps (dashboard → Project Settings → API Keys):**
1. Create/roll the key (for legacy: "Generate new anon key"; for modern: rotate the
   publishable key).
2. Update the two client configs (both gitignored):
   - `clients/admin/.env` → `VITE_SUPABASE_ANON_KEY=…`
   - `clients/pos/local.properties` → `SUPABASE_ANON_KEY=…`
3. Rebuild each client (Vite picks up `.env` on restart; the POS re-reads
   `local.properties` on the next Gradle build).

There is **no downtime** for signed-in users from an anon-key change — the anon key
authenticates the *app to Supabase Auth*, not the user's session.

---

## 2. Rotating the JWT signing key (ES256)

Docs: <https://supabase.com/docs/guides/auth/signing-keys>

This is the cryptographic key that signs user access tokens. Rotation is
**non-disruptive** when done through the standby-key flow.

**How Supabase models it:** a key moves through
`standby → in use (current) → previously used → revoked`. Rotating promotes the
standby key to *in use*; **existing non-expired access tokens keep working**, so
nobody is forcibly signed out.

**Steps (dashboard → Project Settings → JWT Keys):**
1. Supabase pre-creates a **standby** asymmetric key. Review it.
2. Click **Rotate** — the standby becomes the current signing key.
3. Leave the previous key as *previously used* until all old tokens have expired
   (access-token lifetime, default 1 hour), then move it to *revoked*.

**⚠️ Backend follow-up (required).** The backend verifies ES256 tokens against a
**static PEM** in `backend/.env` (`SUPABASE_JWT_PUBLIC_KEY`), derived from the old
JWKS. After rotation you must **re-derive it from the new JWKS** or the backend
will 401 every real login. One command (run from `backend/`):

```bash
node -e "const https=require('https');https.get('https://swuvksmyxkajaebaagkk.supabase.co/auth/v1/.well-known/jwks.json',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{const jwk=JSON.parse(b).keys.find(k=>k.alg==='ES256');const pem=require('crypto').createPublicKey({key:jwk,format:'jwk'}).export({type:'spki',format:'pem'}).toString();console.log('SUPABASE_JWT_PUBLIC_KEY=\"'+pem.trim().replace(/\n/g,'\\\\n')+'\"');})})"
```

Paste the printed line into `backend/.env` and restart the API.

> **Better long term:** have the backend fetch the JWKS at startup (and cache it)
> instead of a static PEM, so signing-key rotation needs no redeploy. Small change
> to `auth.ts`; say the word and I'll do it.

`SUPABASE_JWT_SECRET` (the HS256 test value) is unaffected — leave it.

---

## 3. The identity webhook (auto-provision a tenant on signup)

**Purpose.** When someone signs up in Supabase Auth, provision their local tenant
(user + organization + owner membership) by calling
`POST /api/webhooks/supabase`. Today new users are seeded manually, so this is a
deploy-time nicety, not a blocker.

**Two things make this non-trivial:**

1. **The backend must be publicly reachable.** Supabase calls it over the internet;
   `localhost` and an ngrok tunnel (ephemeral URL) won't do for production. Deploy
   the API first and use its stable HTTPS URL.

2. **Signature formats differ.** Supabase's own signed hooks follow the
   **Standard Webhooks** spec (`webhook-signature` header, `v1,whsec_…` secret),
   which does not match a custom HMAC header out of the box. **Option A is now
   implemented** — the backend accepts either of two schemes, both keyed by
   `SUPABASE_WEBHOOK_SECRET`:

   | Header | Scheme | Use when |
   | --- | --- | --- |
   | `x-supabase-signature` | HMAC-SHA256 over the raw body | The caller can compute an HMAC (an Edge Function bridge, your own service, tests). **Preferred.** |
   | `x-webhook-token` | the secret sent verbatim | **Supabase Database Webhooks**, which can attach static headers but cannot sign a body. |

   A present signature is judged on its own merits and never retried as a token,
   so an attacker holding the token cannot downgrade a signed request by sending
   both. Asserted by a test.

   **Security trade-off, stated plainly:** accepting both means the security is
   that of the *weaker* path. A static token travels on every request, so a
   compromised TLS terminator, proxy, or request log leaks a credential that is
   replayable against any body; the HMAC secret never travels. What makes it
   acceptable: HTTPS in front of the API, a single-purpose secret that grants
   only "provision a tenant from a signup" and no session or data access, and an
   idempotent handler so a replay is a no-op. Move to the HMAC scheme (Option C
   below) if you want that closed.

   Still available if you'd rather not use a static token at all:

   - **Option B — Standard Webhooks.** Swap `webhookAuth` to verify with the
     [`standardwebhooks`](https://www.standardwebhooks.com/) library and a
     `v1,whsec_…` secret, then use a Supabase Auth Hook. Matches Supabase natively.

   - **Option C — Edge Function bridge.** A Supabase Edge Function receives the
     signed hook, verifies it, and re-POSTs using the HMAC scheme above. Most
     flexible, most infrastructure — and the upgrade path off the static token.

**Generate the secret:**

```bash
node -e "console.log('SUPABASE_WEBHOOK_SECRET=' + require('crypto').randomBytes(32).toString('base64url'))"
```

Set it in `backend/.env` **and** the Supabase side. If it is unset the route
correctly **fails closed** (500).

**Create the hook** (dashboard → *Database → Webhooks* → *Create a new hook*):

- Table `auth.users`, event **INSERT**
- Type **HTTP Request**, method **POST**
- URL `https://<your-api>/api/webhooks/supabase`
- HTTP header `x-webhook-token` = the secret

**Verify it locally first** — no Supabase and no public URL needed. With the API
running, this signs a fake signup the way the HMAC scheme expects and posts it:

```bash
cd backend && node -e "const c=require('crypto');const s=require('dotenv').config().parsed.SUPABASE_WEBHOOK_SECRET;const body=JSON.stringify({record:{id:c.randomUUID(),email:'probe@example.com'}});const sig=c.createHmac('sha256',s).update(body).digest('hex');fetch('http://localhost:3000/api/webhooks/supabase',{method:'POST',headers:{'Content-Type':'application/json','x-supabase-signature':sig},body}).then(r=>r.text().then(t=>console.log(r.status,t)))"
```

Expect `200 {"status":"ok","message":"Tenant provisioned",…}`. Re-running the
same id returns `already provisioned` (idempotent, so Supabase retries are
safe). Clean up afterwards:

```sql
DELETE FROM public.organizations WHERE slug LIKE 'org-probe-example-com-%';
DELETE FROM public.users WHERE email = 'probe@example.com';
```

---

## 4. Wiring the POS to Supabase — done ✓

Already configured and verified (the POS anon key byte-matches the authoritative
key from your project). How it works, for reference:

`clients/pos/local.properties` (gitignored) supplies three values that
`app/build.gradle.kts` reads into `BuildConfig` at compile time:

```properties
SUPABASE_URL=https://swuvksmyxkajaebaagkk.supabase.co
SUPABASE_ANON_KEY=<the anon key>
# Backend the app calls. Pick per target:
#   Android emulator     -> http://10.0.2.2:3000/   (alias for the host loopback)
#   Physical device (LAN)-> http://<host-LAN-IP>:3000/
#   Public tunnel/deploy -> https://<public-host>/
BACKEND_BASE_URL=https://<current-backend-url>/
```

Change any value → rebuild the app. The URL/anon key are public; keep the file
gitignored. The on-device offline flow (airplane-mode → reconnect → the failed-sync
banner) is the manual check the CI compile can't cover.

---

## 5. Pre-production checklist

**`backend/.env`:**
- `DATABASE_URL` — point at the production DB; add `?connection_limit=<N>&pool_timeout=10`.
- `SUPABASE_JWT_PUBLIC_KEY` — the current ES256 public PEM (re-derive after any §2 rotation).
- `SUPABASE_WEBHOOK_SECRET` — set once §3 is wired.
- `CORS_ORIGINS` — the real admin origin(s), comma-separated (not `localhost`).
- `RATE_LIMIT_MAX` — tune to expected traffic (default 600/min per IP).
- `TRUST_PROXY=1` — only if behind a reverse proxy/load balancer.

Most of that list is now **checked, not remembered**. The API inspects its
configuration once at boot (`backend/src/config.ts`) and, with
`NODE_ENV=production`, refuses to start — exit **78**, `EX_CONFIG` — when
`DATABASE_URL` is missing, unparseable, or connects as a **superuser** (which
would bypass RLS and disable every tenant boundary); when neither JWT key is
set; or when `CORS_ORIGINS` is unset. It warns, without stopping, about a
missing `TRUST_PROXY` or `REDIS_URL`, and about `SUPABASE_SERVICE_ROLE_KEY`
being present at all.

The line is drawn on purpose: **refuse** what cannot serve traffic, **warn**
about what merely looks wrong. A deploy that fails is rolled back and reported;
a deploy that starts and answers 500 on every request is an outage somebody has
to diagnose, and until this existed `/health` reported `ok` throughout.

**Probes — and they are NOT interchangeable:**

| | question | a bad answer means | touches the DB |
|---|---|---|---|
| `GET /health` | is the process up? | **restart it** | no |
| `GET /ready` | can it serve a request? | **stop routing to it** | yes |

Point the orchestrator's *liveness* probe at `/health` and its *load-balancer*
health check at `/ready`. Wiring liveness to `/ready` turns a database outage
into a restart loop across every instance, over something no restart can fix.
`/ready` answers **503**, not 500, when Postgres is unreachable.

**Container:** `backend/Dockerfile` — multi-stage, runs as the unprivileged
`node` user, ships no devDependencies, and carries a `HEALTHCHECK` on `/ready`.
`.dockerignore` keeps `.env` out of the image; a naive `COPY . .` would
otherwise bake the production database password into a published layer. CI
builds the image on every PR and asserts that an unconfigured container exits
78 rather than starting.

```bash
docker build -t mosaiz-api backend/
```

**Logs.** The API writes **JSON Lines to stdout** — one object per line, which
is what an aggregator already reads and what a container already collects. In
development (`NODE_ENV` not `production`) the same fields print as a readable
line instead. `LOG_LEVEL` is `debug | info | warn | error`, default `info`; an
unrecognised value falls back to `info` and is warned about at boot.

Every request carries a **correlation id**:

- taken from `x-request-id` if the proxy set one (so a trace spans both hops),
  otherwise generated;
- returned in the `x-request-id` **response header**;
- included in the **body of a 500**, as `request_id`.

That last one is the operational point, and **both clients now show it**. The
admin app prints it under a failed page load, and the till prints it under a
failed menu load — as `رقم المرجع`, left-to-right so it can be read back
correctly out of Arabic text, and selectable so it can be copied rather than
retyped.

**Ask for `رقم المرجع` before asking anything else.** It leads to exactly one
line:

```
grep '"request_id":"<the id they read you>"'
```

It is shown only for a **server fault** or an unclassified failure. An expired
session and a role the account does not have are not bugs — the reader already
knows what to do, and an id there would imply somebody is going to investigate.

One thing that is easy to get wrong when adding a new browser client: the
header is only readable because the API names it in
`Access-Control-Expose-Headers` (`exposedHeaders` in `app.ts`). A browser hides
every non-safelisted response header from script, so without that line the id
is on the wire, visible in devtools, and `undefined` to the code meant to
display it — a failure with no symptom at all. Native clients (the POS) are not
subject to this.

    {"time":"2026-08-16T20:41:07.881Z","level":"error","message":"unhandled error",
     "request_id":"6b1f…","method":"POST","path":"/api/pos/checkout","user_id":"…",
     "error_name":"PrismaClientKnownRequestError","error_code":"P2002","error_stack":"…"}

Worth alerting on:

| line | means |
|---|---|
| `message="unhandled error"` | a 500 reached a user. Any of these is a bug. |
| `message="auth rejected: JWT verification failed"` | a run of these is what a key rotation looks like from the server side. Check `reason` — `jwt expired` and `invalid signature` are very different problems. |
| `message="request"` with `status>=500` | as above, counted rather than read. |
| `message="request"` with a large `duration_ms` | one slow endpoint, before anyone reports it. |

**Never in the log, by construction** (`src/lib/logger.ts` logs only named
fields — an allowlist, so a new header cannot start being logged by accident):
headers of any kind including `Authorization` and `Cookie`, request or response
bodies, and query strings. Client addresses are recorded only for requests that
FAILED, and for auth rejections.

The `/health` and `/ready` probes are deliberately **not** logged: an
orchestrator hits them every few seconds and they would be almost the whole
file. They still get a correlation id.

**Platform:**
- TLS termination in front of the API (the app assumes HTTPS).
- Automated Postgres backups + a tested restore.
- Log aggregation + alerting — see **Logs** below for what to alert on.
- A load test of the authenticated path — the one-transaction-per-request model is
  connection-bound; size the pool and the DB `max_connections` against real concurrency.
