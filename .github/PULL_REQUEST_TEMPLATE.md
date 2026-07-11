## Description
<!-- Provide a clear, concise description of the changes introduced by this PR. -->
- **Objective:** [e.g., Implement offline queue retry for POS tablet]
- **Ticket/Issue:** #[Issue Number]

## Bounded Context(s) Modified
<!-- Check all that apply -->
- [ ] Multi-Tenancy & Auth
- [ ] POS & Checkout
- [ ] Inventory & Warehouse
- [ ] HR & Access Control
- [ ] BI & Reporting
- [ ] Shared / Infrastructure

## 🛡️ Architecture & Security Checklist
<!-- MANDATORY: The agent must verify these constraints before requesting a review. -->
- [ ] **Multi-Tenancy:** I have verified that all new database queries respect `organization_id` and rely on existing Row Level Security (RLS) policies. No cross-tenant data leakage is possible.
- [ ] **Idempotency:** Any mutation (Create/Update/Delete) from a client includes a `client_offline_id` to prevent double-processing.
- [ ] **Timezone Agnosticism:** All new operational timestamps use `TIMESTAMPTZ`.
- [ ] **Mobile Client Compatibility:** API responses respect delta-sync requirements (`updated_at`) to optimize payloads for Android/Kotlin clients.

## 🧪 Testing Performed
- [ ] Unit Tests added/updated.
- [ ] Integration Tests simulate concurrent access (if applicable).
- [ ] Code formatted and static analysis passing locally.

## Notes for the Reviewer
<!-- Highlight any complex logic, Edge Functions used, or advisory lock implementations. -->