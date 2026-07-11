# Mosaiz Mundo: Multi-Tenancy and Security Architecture

## 1. Absolute Data Isolation (RLS)
The database operates on a strict B2B SaaS model. Data leakage between restaurants is mathematically impossible at the database engine level.
*   **The Golden Rule:** Every operational table MUST include an `organization_id`.
*   **Implementation:** We utilize PostgreSQL Row Level Security (RLS). The policy `user_belongs_to_org` is enforced on all tables. 
*   **Agent Instruction:** Do not write backend logic that attempts to manually filter by `organization_id` to enforce security; rely on the authenticated database session and RLS policies.

## 2. Multi-Branch Franchising
*   A single user can hold multiple `organization_memberships`.
*   Queries must be context-aware, allowing regional managers to switch branches without logging out. Financial data between branches remains separate.

## 3. Tiered Feature Access
*   The `organizations` table includes a `plan_tier` column. 
*   **Agent Instruction:** When building premium modules (e.g., BI Dashboards or advanced API syncs), check the `plan_tier` before executing the logic.

## 4. Role-Based Access Control (RBAC)
*   Permissions are mapped to human job titles and evaluated via PostgreSQL query caching (`STABLE SECURITY DEFINER`).
*   Database actions are blocked at the engine level if permissions are revoked, overriding front-end UI requests.