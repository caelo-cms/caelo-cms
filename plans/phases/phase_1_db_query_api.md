# Phase 1 — Database + Query API foundation

**Status:** plan ready — awaits user approval before execution.
**Dependencies:** P0 (✓ complete).
**Unblocks:** P2 (admin shell auth), P3 (content model).

## Context

Every later phase reaches for the database through one path: the Query API. If that path is built right *now* — typed named operations, Zod at the boundary, a thin adapter, and RLS that fails closed at the Postgres layer — the rest of the project inherits the safety rails for free. If it's built wrong, every phase carries workarounds.

Goal of P1: a working Query API with one real operation and a complete test harness that proves (a) an undefined operation is impossible, (b) the `public_role` cannot read or write `cms_admin`, (c) an RLS policy stops a cross-actor write at Postgres even when the app-level validator would have allowed it.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Migration tool | **drizzle-kit 0.31.10** (MIT) | TypeScript-native schema, types inferred directly into shared Zod schemas, zero extra binary, smaller tree than Atlas. |
| Query builder / types | **drizzle-orm 0.45.2** (Apache-2.0) | Pairs with drizzle-kit; lives inside the Adapter only — handlers never touch drizzle directly, only the injected `ExecutionContext`. |
| Postgres driver | **Bun.sql** (native, no extra dep) via `drizzle-orm/bun-sql` | One dep fewer (no postgres.js), matches Bun-first posture, stable in Bun 1.3. Swappable at the Adapter layer if ever needed. |
| Operation shape | `defineOperation({ name, actorScope, input: ZodSchema, output: ZodSchema, handler })` | Names are unique; registry rejects unknown names (fail-closed). `actorScope` enum = `human`, `ai`, `plugin`, `system` — Validator uses it to reject e.g. AI actors calling locale-admin ops in P9. |
| Error shape | Tagged union `Result<T, QueryError>` returned from handlers | Matches CLAUDE.md §4 "errors are values at the Query API boundary". Throws reserved for truly exceptional (connection lost, bug). |
| Session identity | `SET LOCAL caelo.actor_id = $1; SET LOCAL caelo.plugin_id = $2;` inside a BEGIN…COMMIT wrapping every op | `SET LOCAL` scopes to the transaction; RLS policies read it via `current_setting('caelo.actor_id', true)`. Not settable from inside a query (we never let untrusted SQL run; op handlers build queries with drizzle). |

## Schema at end of P1 (minimal — just enough to test RLS)

`cms_admin` (written in `packages/migrations/src/schema/cms_admin/*.ts`):
- `actors` — `(id uuid pk, kind text check in ('human','ai','plugin','system'), display_name text, created_at timestamptz)`. Placeholder for real users/AI-actors landed in P2. Seeded with `('system')` during bootstrap so system ops work.
- `audit_events` — `(id uuid pk, actor_id uuid, operation text, input_hash text, succeeded bool, created_at timestamptz)`. RLS: owner-scoped read, system-only write.

`cms_public` (written in `packages/migrations/src/schema/cms_public/*.ts`):
- `rls_sentinel` — `(plugin_id text, payload text, created_at timestamptz)`. Sole purpose: adversarial test that plugin A cannot INSERT a row claiming `plugin_id='B'`. RLS: insert-only, `plugin_id = current_setting('caelo.plugin_id', true)`.

Real tables (pages, modules, templates, snapshots, plugin schemas, etc.) land in their respective phases; P1 stops here.

## RLS policy model

Template applied to every table in both DBs:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;  -- applies to table owner too

-- per-actor (cms_admin): a row is visible/mutable only to its owner actor or system.
CREATE POLICY <t>_actor_scope ON <t>
  USING ( actor_id = current_setting('caelo.actor_id', true)::uuid
          OR current_setting('caelo.actor_kind', true) = 'system' )
  WITH CHECK ( actor_id = current_setting('caelo.actor_id', true)::uuid );

-- per-plugin (cms_public): plugin tables scope INSERT/SELECT to declaring plugin.
CREATE POLICY <t>_plugin_scope ON <t>
  USING ( plugin_id = current_setting('caelo.plugin_id', true) )
  WITH CHECK ( plugin_id = current_setting('caelo.plugin_id', true) );
```

Policy generator lives in `packages/migrations/src/rls.ts`; applied by drizzle migrations (raw SQL migration file per table). Empty-string / NULL setting → no rows match → fail closed.

## Role & grant model

Created by `packages/migrations/src/bootstrap.sql` (run once per provision; idempotent via `IF NOT EXISTS`):

```sql
-- two roles, no implicit privileges on future objects
CREATE ROLE admin_role NOINHERIT LOGIN PASSWORD :'admin_pw';
CREATE ROLE public_role NOINHERIT LOGIN PASSWORD :'public_pw';

-- two databases
CREATE DATABASE cms_admin OWNER admin_role;
CREATE DATABASE cms_public OWNER admin_role;  -- schema owner for migrations

-- connect to cms_admin and grant only admin_role
\connect cms_admin
REVOKE ALL ON DATABASE cms_admin FROM PUBLIC;
GRANT CONNECT ON DATABASE cms_admin TO admin_role;

-- connect to cms_public: admin owns schema, public_role gets INSERT-only on plugin tables
\connect cms_public
REVOKE ALL ON DATABASE cms_public FROM PUBLIC;
GRANT CONNECT ON DATABASE cms_public TO public_role;
-- per-plugin INSERT grants materialise in P11 when plugins register tables
```

## Files to create

```
packages/migrations/
├── drizzle.config.cms-admin.ts
├── drizzle.config.cms-public.ts
├── package.json                             # @caelo/migrations, scripts: db:bootstrap, migrate:admin, migrate:public
├── src/
│   ├── bootstrap.sql                         # roles + DBs; idempotent
│   ├── rls.ts                                # policy-template generator
│   ├── schema/
│   │   ├── cms_admin/
│   │   │   ├── actors.ts
│   │   │   └── audit_events.ts
│   │   └── cms_public/
│   │       └── rls_sentinel.ts
│   └── migrate.ts                            # thin drizzle-kit wrapper invoked per DB
├── migrations/
│   ├── cms_admin/                            # drizzle-kit emits SQL files here
│   └── cms_public/
└── tsconfig.json

packages/shared/src/
├── result.ts                                 # Ok<T> / Err<E> discriminated union + helpers
└── context.ts                                # ExecutionContext type (actor_id, actor_kind, plugin_id?, requestId)

packages/query-api/src/
├── index.ts                                  # public surface
├── errors.ts                                 # QueryError tagged union (UnknownOperation, ValidationFailed, RLSDenied, HandlerError)
├── operation.ts                              # defineOperation<I,O>() signature
├── registry.ts                               # register/lookup, fail-closed on unknown
├── adapter.ts                                # drizzle + Bun.sql setup, opens txn, sets SET LOCAL vars, runs handler, commits/rolls back
├── execute.ts                                # top-level: lookup → validate → run in adapter
└── __tests__/
    ├── operation.test.ts                     # unit
    ├── registry.test.ts                      # unit — unknown op returns Err('UnknownOperation')
    ├── execute.integration.test.ts           # integration — happy path: defineOperation → execute → row persisted
    ├── rls.integration.test.ts               # adversarial: cross-actor write → Err('RLSDenied')
    └── role-isolation.integration.test.ts    # adversarial: public_role → cms_admin → connection-level DENY
```

Environment / compose changes (additive — no P0 rework):

- `.env.example` gains: `ADMIN_DATABASE_URL`, `PUBLIC_DATABASE_URL`, `ADMIN_ROLE_PASSWORD`, `PUBLIC_ROLE_PASSWORD`.
- `docker-compose.yml` gains `volumes: - ./packages/migrations/src/bootstrap.sql:/docker-entrypoint-initdb.d/01-bootstrap.sql:ro` so fresh containers boot with roles + DBs ready; migrations run via `bun run --filter=@caelo/migrations migrate:admin && migrate:public` on local dev and in CI.
- CI workflow gains a `Bootstrap databases` step + a `Run migrations` step between `Install` and `Test`.

## Test plan (three tiers per CLAUDE.md §6)

**Unit** (`bun test packages/query-api/src/__tests__/*.test.ts`):
- `defineOperation` type-level tests: `Input`/`Output` inferred correctly from Zod schemas.
- Registry: double-register throws with a clear message; unknown name returns `Err('UnknownOperation')` — not throws.
- Zod Validator: bad input → `Err('ValidationFailed', issues)`.

**Integration** (`*.integration.test.ts` — `bun test` auto-discovers; they require the compose stack):
- `execute.integration.test.ts` — round-trip: register a test op `audit.record`, call it, row appears in `audit_events`, actor_id and operation fields correct, transaction committed.
- `rls.integration.test.ts` — adversarial matrix, each asserting `Err('RLSDenied')` and zero row mutation in the DB afterwards:
  1. Editor-scoped op tries to read Owner-authored audit_event → 0 rows (not an error, just empty under RLS).
  2. Editor tries to write an audit_event with `actor_id` spoofed to Owner's id → INSERT fails policy `WITH CHECK`.
  3. Plugin A's op tries to INSERT into `rls_sentinel` with `plugin_id='B'` → fails `WITH CHECK`.
  4. Plugin A tries to SELECT plugin B's existing rows → 0 rows.
- `role-isolation.integration.test.ts` — two `postgres` clients, one per role:
  1. `public_role` client tries `SELECT 1 FROM cms_admin.actors` → `permission denied for schema public` / `for table actors`.
  2. `admin_role` client tries `INSERT INTO cms_public.rls_sentinel (...)` without `caelo.plugin_id` set → INSERT fails policy (admin_role has no plugin identity).
  3. A query that would mutate state *and* crashes mid-op: verify the transaction rolled back (no partial write).

**End-to-end verification (captured as a named script):**

```bash
bun install
docker compose up -d
bun run --filter=@caelo/migrations db:bootstrap
bun run --filter=@caelo/migrations migrate:admin
bun run --filter=@caelo/migrations migrate:public
bun run lint
bun run typecheck
bun test
bun run license:check
```

All green = P1 done. A failing `rls.integration.test.ts` means RLS is not `FORCE`d or the `SET LOCAL` chain leaked — both are hard stops; do not "fix" by softening tests.

## Dependencies to add (all MPL-2.0-compatible)

| Package | Version | License | Workspace |
|---|---|---|---|
| drizzle-orm | 0.45.2 | Apache-2.0 | `@caelo/migrations`, `@caelo/query-api` |
| drizzle-kit | 0.31.10 | MIT | `@caelo/migrations` (dev) |

No `postgres` / `pg` / `node-postgres` — Bun.sql used directly via `drizzle-orm/bun-sql`.

## What P1 explicitly does NOT do

- No user / role / session tables — those land in P2 with SvelteKit auth.
- No content tables (pages / modules / templates) — P3.
- No snapshot tables — P4.
- No plugin table registration flow — P11 (P1 just models how `rls_sentinel` would look, so P11 has a pattern to copy).
- No rate limiting inside the Validator — stub interface only; real limits in P13 at the gateway.
- No admin UI — P2.
- No AI caller yet — P5 wires AI actors into the `actor_kind='ai'` code path.

## Risks & open threads (call out before starting)

1. **Bun.sql + drizzle-bun-sql + Bun 1.3.13 specific edge cases.** Drizzle's Bun adapter is relatively new (~6 months stable). If we hit a connection-pool or `SET LOCAL` surprise, fallback is `postgres` (postgres.js) — one-line Adapter swap, no schema/type changes.
2. **`NOINHERIT` on roles.** Needed so `admin_role` never accidentally gets `public_role`'s privileges via group membership. Double-check the test matrix covers this.
3. **Migrations running as `admin_role` in `cms_public`.** `admin_role` owns the `cms_public` schema for DDL, but never holds a connection pool that application code uses against `cms_public`. Make sure the migration scripts and the application pools use distinct connection strings, and that the application admin pool points at `cms_admin` only.
4. **`audit_events.actor_id` should be NOT NULL** — otherwise the RLS policy's `NULL = NULL` rule gives false negatives. Enforce at schema level + backfill system rows with the seeded `system` actor id.

---

Ready to execute once approved. Estimated effort: 1 focused session (~4–6 hours incl. test matrix + green CI).
