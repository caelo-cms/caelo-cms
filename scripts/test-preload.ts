// SPDX-License-Identifier: MPL-2.0

/**
 * Bun test preload — wired in `bunfig.toml` `[test] preload`.
 *
 * Solves two long-standing pain points in the integration suite that
 * shipped intermittent flakes (e.g. step 12 of the workflow runs):
 *
 *   1. **Cross-file Postgres state pollution.** 60+ integration test files
 *      share one `cms_admin` + `cms_public` database. Each file only wipes
 *      its own prefix-scoped rows, so debris (chat sessions, snapshots,
 *      audit events, rate-limit buckets, …) accumulates as the suite
 *      progresses. Queries that scan churn tables (the cross-chat scan
 *      with 6 correlated subqueries per row, the rate limiter's first
 *      INSERT, locales' wipe DELETEs) get slower file-by-file, until
 *      they trip Bun's 5-second hook timeout — or in the rate limiter's
 *      case, the transaction takes long enough that `pg_now()` (captured
 *      at tx start) lags JS `Date.now()` by the time the await resolves,
 *      and `retryAfterMs = max(0, expires - Date.now())` collapses to 0.
 *
 *   2. **Pool churn from transient `new SQL(URL)` instances** in 127
 *      test-helper `wipe()` calls. Each opens a fresh Bun.SQL pool just
 *      to run a few DELETEs and then `.end()`s it; cold-connect (TCP +
 *      auth + role-identity probe) costs add up under load.
 *
 * The fix here addresses (1) directly and (2) indirectly. With Bun
 * `--isolate` (set on the test script in package.json), the top-level
 * `beforeAll` registered here fires per file, so every file starts with
 * a freshly-truncated DB regardless of what the preceding files did.
 * That alone collapses the load symptom: queries stay fast, transactions
 * commit in milliseconds, hooks finish well under their budget.
 *
 * Approach: dynamically enumerate every user table in `cms_admin` /
 * `cms_public`, subtract a curated `PRESERVE` allowlist of seed-bearing
 * tables (locales' `en`, the layout / template / site_defaults seed
 * chain, builtin roles + permissions, etc.), and TRUNCATE the rest in
 * one statement with CASCADE. Dynamic enumeration means new churn
 * tables added in future migrations are picked up automatically; the
 * allowlist only needs editing when a NEW seed-bearing table lands.
 *
 * Two carve-outs handled specially:
 *
 *   - **`plugins`** has `actors.plugin_id` FK with `ON DELETE SET NULL`.
 *     TRUNCATE plugins CASCADE would cascade *into* `actors` (truncating
 *     the system-actor seed) — wrong. Plain `DELETE FROM plugins`
 *     respects the SET NULL rule and leaves the actor row intact.
 *
 *   - **`__drizzle_migrations`** and **`rls_sentinel`** are infrastructure
 *     tables; preserving them keeps migration state and the RLS probe
 *     row that some adversarial-RLS tests depend on.
 *
 * Also bumps Bun's default test + hook timeout from the 5s default to
 * 30s. Several integration `beforeAll` / `afterEach` hooks open a
 * fresh `Bun.SQL` pool, run a multi-statement wipe transaction, and
 * close — under load the cold-connect + identity probe + DELETEs were
 * exceeding 5s. The truncate fix above removes the load that pushed
 * hooks over budget; the timeout bump is belt-and-braces so a slow CI
 * runner can't flake on a one-off slow query.
 *
 * If `ADMIN_DATABASE_URL` / `PUBLIC_ADMIN_DATABASE_URL` are unset
 * (running `bun test` against a non-integration target), the preload
 * is a no-op except for the timeout bump.
 */

import { beforeAll, setDefaultTimeout } from "bun:test";
import { SQL } from "bun";

// Bound every DatabaseAdapter constructed during the test run. This preload
// runs before any test module builds an adapter, so all ~83 inline
// `new DatabaseAdapter(...)` call sites inherit this cap without per-file
// edits — the adapter reads `CAELO_DB_POOL_MAX` (see packages/query-api
// resolvePoolMax). Two pools per adapter (admin + public) x 3 = 6 connections
// instead of Bun's default 2 x 10 = 20. The suite runs sequentially (one file
// at a time under `--isolate`; see bunfig.toml on why it must not be made
// parallel), so only one file's pools are live at once, keeping the suite well
// under Postgres `max_connections` (100). `??=` lets an explicit override win.
// 3 (not 1) avoids the single-connection self-deadlock; see resolvePoolMax.
process.env.CAELO_DB_POOL_MAX ??= "3";

// Default hook + test timeout. Integration `wipe()` helpers open a
// fresh Bun.SQL pool every call; the cold-connect path can spike past
// the 5-second Bun default under load. 30s matches the longest
// per-test budget already set in the suite (chat-list-open-with-pending).
setDefaultTimeout(30_000);

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL ?? process.env.PUBLIC_DATABASE_URL;

/**
 * Tables in `cms_admin` whose rows come from migrations (not test
 * inserts). Truncating them would force every file to re-seed the
 * builtin roles / permissions / locales / layout chain / etc., which is
 * the wrong layer to do that at. New entries here only when a NEW
 * seed-bearing table lands in a migration.
 */
const ADMIN_PRESERVE: ReadonlySet<string> = new Set([
  "__drizzle_migrations",
  "actors",
  "ai_pricing",
  "deploy_targets",
  "email_config",
  "layout_blocks",
  "layouts",
  "locales",
  "permissions",
  "rate_limit_profiles",
  "release_check_cache",
  "role_permissions",
  "roles",
  "site_defaults",
  "site_settings",
  "skills",
  "structured_sets",
  "telemetry_settings",
  "template_blocks",
  "templates",
  // Seed-bearing since 0097/0099 (the `site-default` row + its tokens).
  // Truncating it left dev installs with NO active theme: the themes UI
  // showed an empty state, POST_CHAT_SEED's fast-forward UPDATE matched
  // no row, and the cold-start gate fired on every mock-AI spec (#112).
  // Tests that mutate themes wipe their own slug-prefixed rows and
  // restore the active flag themselves (see
  // themes-pending.integration.test.ts).
  "themes",
]);

/**
 * `cms_public` has no seed-bearing tables today. `rls_sentinel` is a
 * one-row marker used by adversarial-RLS tests to confirm the public
 * pool can read its own DB; preserve it so those tests don't false-fail
 * after a reset.
 */
const PUBLIC_PRESERVE: ReadonlySet<string> = new Set(["__drizzle_migrations", "rls_sentinel"]);

/**
 * Tables whose churn rows must go, but whose TRUNCATE ... CASCADE would
 * wipe a PRESERVE table that references them — CASCADE truncates every
 * referencing table regardless of the allowlist, while plain DELETE
 * honours the FK's ON DELETE action:
 *
 *   - `plugins`: `actors.plugin_id` is ON DELETE SET NULL; CASCADE
 *     would clear the system-actor seed.
 *   - `media_assets` (#112): the seeded `themes` row's asset slots
 *     (`logo_media_id` etc.) are ON DELETE SET NULL; CASCADE truncated
 *     `themes` and left installs with no active theme (empty themes UI,
 *     cold-start gate firing on every mock-AI spec).
 *
 * These DELETEs run AFTER the truncate so plain NO ACTION references
 * from churn tables (e.g. `pages_seo.og_image_asset_id`) are already
 * gone and can't block the DELETE.
 */
const DELETE_NOT_TRUNCATE: ReadonlySet<string> = new Set(["plugins", "media_assets"]);

async function resetDatabase(url: string, preserve: ReadonlySet<string>): Promise<void> {
  // The reset runs one `.begin()` (a single connection) plus a table
  // enumeration query — cap the transient pool so it cannot contribute to
  // connection-slot pressure when many workers reset concurrently.
  const sql = new SQL(url, { max: 2 });
  try {
    const allTables = (await sql`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
    `) as unknown as { tablename: string }[];

    const truncateTargets = allTables
      .map((t) => t.tablename)
      .filter((name) => !preserve.has(name) && !DELETE_NOT_TRUNCATE.has(name));

    const deleteTargets = allTables
      .map((t) => t.tablename)
      .filter((name) => DELETE_NOT_TRUNCATE.has(name));

    if (truncateTargets.length === 0 && deleteTargets.length === 0) return;

    await sql.begin(async (tx) => {
      // RLS policies on most tables require a non-empty actor_kind. The
      // table owner (admin_role) bypasses RLS for TRUNCATE but DELETE
      // honours it under FORCE ROW LEVEL SECURITY, so set the session
      // var defensively.
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");

      // TRUNCATE the churn set in one statement. CASCADE propagates to
      // referencing tables, which is why any table a PRESERVE table
      // references must sit in DELETE_NOT_TRUNCATE instead — see its
      // doc comment.
      if (truncateTargets.length > 0) {
        const quoted = truncateTargets.map((t) => `"${t}"`).join(", ");
        await tx.unsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
      }

      // DELETE after the truncate: churn rows referencing these tables
      // are already gone, and the FKs' ON DELETE SET NULL keeps the
      // seeded rows in `actors` / `themes` alive.
      for (const t of deleteTargets) {
        await tx.unsafe(`DELETE FROM "${t}"`);
      }
    });
  } finally {
    await sql.end();
  }
}

if (ADMIN_URL && PUBLIC_URL) {
  beforeAll(async () => {
    await Promise.all([
      resetDatabase(ADMIN_URL, ADMIN_PRESERVE),
      resetDatabase(PUBLIC_URL, PUBLIC_PRESERVE),
    ]);
  });
}
