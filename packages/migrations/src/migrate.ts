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
 * login (runner.ts `retargetVisitorRole`).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseUrlFromEnv } from "@caelo-cms/shared";
// Read SQL via globalThis.Bun (Bun's runtime sets it natively). The
// type-only import is erased at compile time so the bundler never sees
// a value-import of "bun" — avoids the SvelteKit/Vite chain inlining
// a stub package when admin transitively imports this module.
import type { SQL as SQLType } from "bun";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { type ProjectionDatabases, publishPublicProjection } from "./public-projection.js";
import { assertNoRlsPolicyDrift } from "./rls.js";
import {
  assertPublicDatabaseIsolated,
  assertPublicDatabaseOwnsItsLogin,
  assertRoleIsolation,
  type PublicDatabase,
} from "./role-audit.js";
import { LIVE_VISITOR_ROLE, runMigrations, STAGING_VISITOR_ROLE } from "./runner.js";
import { readShippedVisitorProjections } from "./shipped-declarations.js";

const SQL = (globalThis as { Bun?: { SQL: new (url: string) => SQLType } }).Bun
  ?.SQL as unknown as new (
  url: string,
) => SQLType;

type Target = "admin" | "public" | "public-staging";

/** Per target: the database, the URL var it is reached by, and its visitor login. */
const TARGETS: Readonly<
  Record<
    Target,
    { database: "cms_admin" | PublicDatabase; urlEnv: string; visitorRole: string | null }
  >
> = {
  admin: { database: "cms_admin", urlEnv: "ADMIN_DATABASE_URL", visitorRole: null },
  public: {
    database: "cms_public",
    urlEnv: "PUBLIC_ADMIN_DATABASE_URL",
    visitorRole: LIVE_VISITOR_ROLE,
  },
  "public-staging": {
    database: "cms_public_staging",
    urlEnv: "PUBLIC_STAGING_ADMIN_DATABASE_URL",
    visitorRole: STAGING_VISITOR_ROLE,
  },
};

const target = process.argv[2];
if (target !== "admin" && target !== "public" && target !== "public-staging") {
  console.error("usage: bun run src/migrate.ts <admin|public|public-staging>");
  process.exit(1);
}
const spec = TARGETS[target];

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
    admin: new SQL(urls.admin),
    live: new SQL(urls.live),
    staging: new SQL(urls.staging),
  };
  const admin = drizzle(clients.admin);
  const pub = { live: drizzle(clients.live), staging: drizzle(clients.staging) };
  const asSystem = dsql`SELECT set_config('caelo.actor_kind', 'system', true)`;
  const dbs: ProjectionDatabases = {
    readAdmin: (fn) =>
      admin.transaction(async (tx) => {
        await tx.execute(asSystem);
        return fn(tx);
      }),
    writePublic: (target, fn) =>
      pub[target].transaction(async (tx) => {
        await tx.execute(asSystem);
        await fn(tx);
      }),
  };
  try {
    const declarations = readShippedVisitorProjections(resolve(here, "..", "..", "plugins"));
    const report = await publishPublicProjection(dbs, declarations, { comments: true });
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

const sql = new SQL(url);
try {
  await assertConnectedTo(sql, spec.database);
  await runMigrations(
    sql,
    migrationsDir,
    spec.visitorRole ? { visitorRole: spec.visitorRole } : {},
  );
  await assertNoRlsPolicyDrift(sql);
  console.log(`${spec.database}: migrations applied, RLS drift check passed`);
  if (spec.database === "cms_admin") {
    // Issue #633 — the role catalogue is cluster-wide, so one run (on
    // cms_admin, where the CONNECT check matters) covers both databases.
    // A violation exits non-zero: the migration job fails and no upgrade
    // rolls a service onto an install whose public login is over-privileged.
    const audit = await assertRoleIsolation(sql);
    for (const w of audit.warnings) console.warn(`role isolation warning: ${w}`);
    console.log("cms_admin: database role isolation check passed");
  } else {
    // Issue #635 — nothing in a public database may bridge to another one.
    await assertPublicDatabaseIsolated(sql, spec.database);
    console.log(`${spec.database}: no bridge to other databases`);
    // Issue #1329 — nor grant anything to the other environment's gateway.
    await assertPublicDatabaseOwnsItsLogin(sql, spec.database);
    console.log(`${spec.database}: only ${spec.visitorRole} holds visitor privileges`);
    if (spec.database === "cms_public_staging") await publishProjection();
  }
} finally {
  await sql.end();
}

/**
 * Refuse a URL that reaches another database than the target's: running
 * the cms_public files with the staging role on cms_public (or the reverse)
 * would grant the wrong gateway its privileges. A missing staging database
 * names how the install creates it.
 */
async function assertConnectedTo(client: SQLType, database: string): Promise<void> {
  let rows: { db: string }[];
  try {
    rows = (await client.unsafe("SELECT current_database()::text AS db")) as { db: string }[];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (database === "cms_public_staging" && /does not exist/.test(message)) {
      throw new Error(
        `cms_public_staging does not exist (#1329: staging has a database of its own). Cloud installs create it in the converge (\`cms-provision upgrade\`, or Install update in Settings → Updates); self-hosted: \`cms-provision up\`; a local database: re-run packages/migrations/src/bootstrap.sh as the superuser with PUBLIC_STAGING_ROLE_PASSWORD set. (${message})`,
      );
    }
    throw e;
  }
  const db = rows[0]?.db;
  if (db !== database) {
    throw new Error(`migrate ${target}: ${spec.urlEnv} reaches ${db}, not ${database}`);
  }
}
