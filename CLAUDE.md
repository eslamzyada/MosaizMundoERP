# Mosaiz Mundo ERP — Agent Instructions

Multi-tenant restaurant ERP. PostgreSQL-first: tenant isolation is done by
Row Level Security, business mutations go through SECURITY DEFINER stored
procedures. Verify claims against the running database — never assert schema
or policy behavior without executing it.

**Read before touching anything:**
- `docs/rls_policies.md` — before any schema or query work
- `docs/pos_offline.md` — before checkout/inventory work
- `docs/ai_system_prompt.md` — architecture and workflow mandates

## Non-negotiable workflow

- **Never commit directly to `main`.** Every change goes through a feature
  branch and a Pull Request (fill out `.github/PULL_REQUEST_TEMPLATE.md`).
- A PR merges only when the **Database CI** check is green. It applies every
  migration to a clean PostgreSQL 18 and runs the assertion suites in
  `db/tests/` — if behavior isn't proven there, it doesn't exist.
- Migrations are **append-only**: next 4-digit prefix in `db/migrations/`,
  never edit a migration that has already been applied anywhere.
- Migrations run as `postgres` (object owner). The application connects as
  `mosaiz_app_user` (LOGIN, no BYPASSRLS, owns nothing) — every privilege it
  holds must be granted explicitly in the migration (guarded DO block, see
  0001–0003 for the convention).
- Every new operational table MUST have: `organization_id` + the
  `user_belongs_to_org` RLS policy, `updated_at` + the `app.set_updated_at`
  trigger, and RLS enabled (`ENABLE`, never `FORCE` — FORCE breaks the
  SECURITY DEFINER helpers).
- Identity-adjacent tables follow deny-by-default: no INSERT/DELETE policies;
  those mutations only happen through SECURITY DEFINER procedures with
  `SET search_path = ''` and EXECUTE revoked from PUBLIC.
- Every schema change extends `db/tests/` in the same PR — positive
  assertions in SQL DO blocks, must-be-rejected cases in
  `negative_checks.sh`.

## Local environment

- Database: PostgreSQL 18 on **port 5433** (`mosaiz_mundo`). Port 5432 is a
  different, older instance — do not use it.
- MCP servers (`.mcp.json`, gitignored — contains credentials, never commit
  or recreate it in git): `postgres_app` (app role) and `postgres_admin`
  (superuser, for DDL).
- `psql` is not on PATH: use `C:\Program Files\PostgreSQL\18\bin\psql.exe`.

## API Gateway (`backend/`)

- Node + Express + TypeScript + Prisma. The DB schema is owned by the SQL
  migrations, NEVER by Prisma Migrate. Prisma is introspection + query only:
  after applying a new migration, re-run `npm run db:pull` to refresh
  `prisma/schema.prisma`, then `npm run build`.
- The API connects as `mosaiz_app_user` (never `postgres`), so every query is
  under RLS. `.env` holds `DATABASE_URL` and is gitignored (`.env.example` is
  the template).
- RLS contract: the auth middleware runs each handler inside ONE Prisma
  interactive transaction that first binds the identity with
  `set_config('app.current_user_id', $1, true)` — NOT `SET LOCAL ... = $1`,
  which is a syntax error (SET rejects bind parameters). Handlers must query
  via `req.tx`, not the global client, or RLS sees no user.
- CI job "Backend Build" runs `npm install` + `npm run build` (which runs
  `prisma generate` from the committed schema, no DB needed).
