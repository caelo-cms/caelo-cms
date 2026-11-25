// SPDX-License-Identifier: MPL-2.0

/**
 * Runs the committed SQL migrations for cms_admin, cms_public or (#1329)
 * cms_public_staging, applies RLS to the bookkeeping table, and runs a
 * drift check that asserts every app table has at least one RLS policy.
 *
 *   bun run src/migrate.ts admin
 *   bun run src/migrate.ts public
 *   bun run src/migrate.ts public-staging
 *
 * The staging database is the twin of cms_public: the same migration files,
 * with the visitor role they grant to retargeted to the staging gateway's
 * login (runner.ts `installNameTokens`).
 *
 * Issue #1689 — the install's role and database names come from its name
 * map (`CAELO_INSTALL_NAMES`, today's names when unset): the runner renames
 * them in every migration file, the connected database must be the
 * install's, and the role audit checks the install's roles and that
 * nothing reaches or is granted to another install on the same server.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  databaseUrlFromEnv,
  type InstallNames,
  installNamesFromEnv,
  type LogicalDatabase,
  physicalDatabaseName,
} from "@caelo-cms/shared";
// Read SQL via globalThis.Bun (Bun's runtime sets it natively). The
// type-only import is erased at compile time so the bundler never sees
// a value-import of "bun" — avoids the SvelteKit/Vite chain inlining
// a stub package when admin transitively imports this module.
import type { SQL as SQLType } from "bun";
import { publishProjectionOver } from "./projection-publish.js";
import { assertNoRlsPolicyDrift } from "./rls.js";
import {
  assertNoForeignReferences,
  assertPublicDatabaseIsolated,
  assertPublicDatabaseOwnsItsLogin,
  assertRoleIsolation,
  publicDatabaseLogin,
} from "./role-audit.js";
import { type MigrationTarget, runMigrations } from "./runner.js";

const SQL = (globalThis as { Bun?: { SQL: new (url: string, o?: { max?: number }) => SQLType } })
  .Bun?.SQL as unknown as new (
  url: string,
  o?: { max?: number },
) => SQLType;

/**
 * Connections each pool of this run may open. A run needs two at most (a
 * migration's transaction, the projection's read next to its write); Bun's
 * default of 10 per pool would make the four pools of a run ask for 40, more
 * than an admin login bounded on a shared server allows (#1689,
 * ADMIN_ROLE_CONNECTION_LIMIT), and more than the run uses.
 */
const RUN_POOL_MAX = 2;

/** Per target: the logical database and the URL var it is reached by. */
const TARGETS: Readonly<Record<MigrationTarget, { database: LogicalDatabase; urlEnv: string }>> = {
  admin: { database: "cms_admin", urlEnv: "ADMIN_DATABASE_URL" },
  public: { database: "cms_public", urlEnv: "PUBLIC_ADMIN_DATABASE_URL" },
  "public-staging": {
    database: "cms_public_staging",
    urlEnv: "PUBLIC_STAGING_ADMIN_DATABASE_URL",
  },
};

const target = process.argv[2];
if (target !== "admin" && target !== "public" && target !== "public-staging") {
  console.error("usage: bun run src/migrate.ts <admin|public|public-staging>");
  process.exit(1);
}
const spec = TARGETS[target];
const names: InstallNames = installNamesFromEnv();
const physical = physicalDatabaseName(names, spec.database);

const url = databaseUrlFromEnv([spec.urlEnv]);
if (!url) {
  console.error(`missing env var: ${spec.urlEnv}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
// Both public databases run the cms_public files.
const migrationsDir = resolve(
  here,
  "..",
  "migrations",
  target === "admin" ? "cms_admin" : "cms_public",
);

/**
 * Issue #635 — once both public databases are migrated (the last target,
 * `public-staging`, #1329), publish the projection the gateways read (they
 * have no cms_admin login), so a gateway rolled right after this job finds
 * everything it serves from. Needs every URL: every runner (the Cloud Run
 * migration job, the self-hosted admin container, CI, `bun run db:migrate`)
 * carries them. The shipped plugins' declarations let an install from
 * before #1329 freeze its first release state here; with a runtime-installed
 * plugin active, the admin's boot does it instead.
 */
async function publishProjection(): Promise<void> {
  const urls = {
    admin: databaseUrlFromEnv(["ADMIN_DATABASE_URL"]),
    live: databaseUrlFromEnv(["PUBLIC_ADMIN_DATABASE_URL"]),
    staging: databaseUrlFromEnv(["PUBLIC_STAGING_ADMIN_DATABASE_URL"]),
  };
  if (!urls.admin || !urls.live || !urls.staging) {
    throw new Error(
      "migrate public-staging: ADMIN_DATABASE_URL, PUBLIC_ADMIN_DATABASE_URL and PUBLIC_STAGING_ADMIN_DATABASE_URL are required to publish the gateways' projection (issues #635, #1329); the migration job carries all three",
    );
  }
  const clients = {
    admin: new SQL(urls.admin, { max: RUN_POOL_MAX }),
    live: new SQL(urls.live, { max: RUN_POOL_MAX }),
    staging: new SQL(urls.staging, { max: RUN_POOL_MAX }),
  };
  try {
    const report = await publishProjectionOver(clients);
    console.log(
      `gateway projection published — cms_public: ${report.sections.live.join(", ")}; cms_public_staging: ${report.sections.staging.join(", ")}`,
    );
    for (const target of report.unreleased) {
      console.warn(
        `${target}: no frozen release state yet (an active plugin is not shipped in this image); the admin freezes it when it boots`,
      );
    }
  } finally {
    await clients.admin.end();
    await clients.live.end();
    await clients.staging.end();
  }
}

const sql = new SQL(url, { max: RUN_POOL_MAX });
try {
  await assertConnectedTo(sql, spec.database);
  await runMigrations(sql, migrationsDir, { names, target });
  await assertNoRlsPolicyDrift(sql);
  console.log(`${physical}: migrations applied, RLS drift check passed`);
  // Issue #1689 — nothing in this database belongs to another install's role.
  await assertNoForeignReferences(sql, spec.database, names);
  if (spec.database === "cms_admin") {
    // Issue #633 — the role catalogue is cluster-wide, so one run (on
    // cms_admin, where the CONNECT check matters) covers both databases.
    // A violation exits non-zero: the migration job fails and no upgrade
    // rolls a service onto an install whose public login is over-privileged.
    const audit = await assertRoleIsolation(sql, names);
    for (const w of audit.warnings) console.warn(`role isolation warning: ${w}`);
    console.log(`${physical}: database role isolation check passed`);
  } else {
    // Issue #635 — nothing in a public database may bridge to another one.
    await assertPublicDatabaseIsolated(sql, spec.database, names);
    console.log(`${physical}: no bridge to other databases`);
    // Issue #1329 — nor grant anything to the other environment's gateway.
    await assertPublicDatabaseOwnsItsLogin(sql, spec.database, names);
    console.log(
      `${physical}: only ${publicDatabaseLogin(names, spec.database)} holds visitor privileges`,
    );
    if (spec.database === "cms_public_staging") await publishProjection();
  }
} finally {
  await sql.end();
}

/**
 * Refuse a URL that reaches another database than the target's: running
 * the cms_public files with the staging role on cms_public (or the reverse)
 * would grant the wrong gateway its privileges, and (#1689) running them on
 * another install's database would grant this install's roles in it. A
 * missing staging database names how the install creates it.
 */
async function assertConnectedTo(client: SQLType, database: LogicalDatabase): Promise<void> {
  const expected = physicalDatabaseName(names, database);
  let rows: { db: string }[];
  try {
    rows = (await client.unsafe("SELECT current_database()::text AS db")) as { db: string }[];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (database === "cms_public_staging" && /does not exist/.test(message)) {
      throw new Error(
        `${expected} does not exist (#1329: staging has a database of its own). Cloud installs create it in the converge (\`cms-provision upgrade\`, or Install update in Settings → Updates); self-hosted: \`cms-provision up\`; a local database: re-run packages/migrations/src/bootstrap.sh as the superuser with PUBLIC_STAGING_ROLE_PASSWORD set. (${message})`,
      );
    }
    throw e;
  }
  const db = rows[0]?.db;
  if (db !== expected) {
    throw new Error(
      `migrate ${target}: ${spec.urlEnv} reaches ${db}, not ${expected}${expected === database ? "" : ` (the install's ${database}, CAELO_INSTALL_NAMES)`}`,
    );
  }
}
