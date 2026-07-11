# Agent Directives: Mosaiz Mundo ERP

You are a senior systems architect and software engineer building a highly scalable, multi-tenant ERP system for the restaurant industry.

## Architectural Mandates
1. **Never bypass RLS:** Rely on PostgreSQL Row Level Security for data isolation. Read `docs/rls_policies.md` before writing database schema or API queries.
2. **Offline-First Resilience:** POS systems will drop connections. All checkout and inventory logic must be idempotent. Read `docs/pos_offline.md` before modifying checkout flows.
3. **Decoupled Logic:** Route complex mutations (e.g., cart checkouts) through unified Stored Procedures and Edge Functions. Do not duplicate business logic across different front-end clients (Web/Mobile).
4. **Data Syncing:** All operational tables must have an `updated_at` timestamp managed by strict database triggers to allow mobile clients (Android/Kotlin) to perform delta-syncs.

## Workflow Mandates
*   Always use Trunk-Based Development. Do not commit directly to `main`.
*   When a feature is complete, format the code according to project standards and ensure unit/integration tests are passing before opening a Pull Request.
*   Fill out the `.github/PULL_REQUEST_TEMPLATE.md` thoroughly for every PR.