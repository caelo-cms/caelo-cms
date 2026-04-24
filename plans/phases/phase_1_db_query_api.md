# Phase 1 — Database + Query API foundation

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P0.
**Unblocks:** P2, P3.

## Goal (from master plan)
Provision two databases (`cms_admin`, `cms_public`) with two isolated PostgreSQL roles (`admin_role`, `public_role`) and a migration tool (drizzle-kit or Atlas). Build the Query API layer: typed named operations → Zod Validator → Database Adapter → PostgreSQL. **Row-Level Security (RLS) enabled and `FORCE`d on every table in both databases** — per-actor write scoping in `cms_admin`, per-plugin-table INSERT scoping in `cms_public` (required by requirements §12.3). Only `cms_admin` schema scaffolded here (tables come later). Deliverable: calling an undefined operation fails closed; `public_role` proven to have zero privileges on `cms_admin`; RLS adversarial tests fail closed.

## End-to-end verification
Manual Query API call succeeds; undefined operation rejected; cross-DB role leak test fails closed; RLS adversarial tests fail closed (Editor cannot write as Owner; plugin A cannot INSERT into plugin B's table).

## To be detailed before execution
- Migration tool choice (drizzle-kit vs Atlas — verify current versions and Bun compat).
- Role/grant SQL bootstrap scripts.
- **RLS policy templates** — per-actor scoping uses `current_setting('caelo.actor_id')`; per-plugin scoping uses `current_setting('caelo.plugin_id')`. Adapter sets these session variables on every connection checkout, unsettable from inside a query.
- **`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`** on every table, including for table owners — no bypass path.
- Query API shape: `defineOperation({ name, input: ZodSchema, output: ZodSchema, handler })`.
- Validator responsibilities (shape, rate-limit hooks, injection prevention) vs Adapter responsibilities.
- Integration test harness: spin real Postgres via compose, run Query API ops against it.
- Adversarial test matrix: `public_role` → `cms_admin` (role leak), cross-actor writes under RLS, cross-plugin-table writes under RLS. All must fail at the Postgres layer, not just the app layer.
