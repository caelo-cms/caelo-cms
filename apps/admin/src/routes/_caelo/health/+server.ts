// SPDX-License-Identifier: MPL-2.0

/**
 * Admin health endpoint.
 *
 *   GET /_caelo/health         → `{ ok, version }` once both database pools
 *                                connect as the expected roles.
 *   GET /_caelo/health?deep=1  → additionally `migrations: { admin, public }`
 *                                (`{ head, pending }` each): every migration
 *                                file this image ships must be recorded as
 *                                applied, or the answer is 503.
 *
 * `cms-provision upgrade` (and the in-cloud upgrader job, epic #696) calls
 * the deep variant right after rolling the admin onto a new image and rolls
 * traffic back when it fails — Cloud Run's readiness only proves the port
 * listens, while a revision that cannot reach its database or runs against
 * an older schema serves 500s on every page.
 *
 * No app-level auth: on GCP the infrastructure gates it (IAP in front of the
 * admin; the upgrade signs an IAP credential for it). The answer carries no
 * secrets and no raw database errors — those go to the server log.
 */

import { execute } from "@caelo-cms/query-api";
import { CAELO_VERSION, type ExecutionContext } from "@caelo-cms/shared";
import { json } from "@sveltejs/kit";
import {
  type MigrationDatabase,
  type MigrationState,
  migrationState,
  shippedMigrations,
  shippedMigrationsRoot,
} from "#lib/server/migration-state.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

/** The fixed system actor the admin's system-dispatched paths use (hooks.server.ts). */
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

const OPS: Record<MigrationDatabase, string> = {
  cms_admin: "platform_health.applied_admin_migrations",
  cms_public: "platform_health.applied_public_migrations",
};

const NO_STORE = { "Cache-Control": "no-store" };

function unhealthy(kind: string, message: string) {
  return json(
    { ok: false, version: CAELO_VERSION, error: { kind, message } },
    { status: 503, headers: NO_STORE },
  );
}

export const GET: RequestHandler = async ({ url }) => {
  const { adapter, registry } = getQueryContext();
  try {
    // The lightest check that proves a working connection AND the expected
    // role on both pools (catches a swapped or misrouted database URL).
    await adapter.verifyRoles();
  } catch (e) {
    console.error(`[health] database check failed: ${(e as Error).message}`);
    return unhealthy("DbUnreachable", "a database pool cannot connect as its expected role");
  }
  if (url.searchParams.get("deep") !== "1") {
    return json({ ok: true, version: CAELO_VERSION }, { headers: NO_STORE });
  }

  let root: string;
  try {
    root = shippedMigrationsRoot();
  } catch (e) {
    console.error(`[health] ${(e as Error).message}`);
    return unhealthy("MigrationsUnknown", "this image carries no migration files");
  }
  const ctx: ExecutionContext = {
    actorId: SYSTEM_ACTOR_ID,
    actorKind: "system",
    requestId: crypto.randomUUID(),
  };
  const migrations: Partial<Record<"admin" | "public", MigrationState>> = {};
  for (const database of ["cms_admin", "cms_public"] as const) {
    const r = await execute(registry, adapter, ctx, OPS[database], {});
    if (!r.ok) {
      console.error(`[health] ${OPS[database]}: ${JSON.stringify(r.error)}`);
      return unhealthy("MigrationStateUnreadable", `could not read ${database}'s migrations`);
    }
    const { applied } = r.value as { applied: string[] };
    migrations[database === "cms_admin" ? "admin" : "public"] = migrationState(
      shippedMigrations(root, database),
      applied,
    );
  }
  const ok = migrations.admin?.pending === 0 && migrations.public?.pending === 0;
  return json(
    { ok, version: CAELO_VERSION, migrations },
    { status: ok ? 200 : 503, headers: NO_STORE },
  );
};
