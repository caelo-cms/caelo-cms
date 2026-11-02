// SPDX-License-Identifier: MPL-2.0

/**
 * #1332 (E10) — the table kinds are enforced by Postgres, not only by the
 * host: the visitor role holds exactly the privileges each kind allows
 * (plugin-sandbox `VISITOR_TABLE_PRIVILEGES`), the admin role all four.
 * The public side is assumed compromised (docs/dev/public-admin-boundary.md),
 * so the test also connects AS the visitor role and tries what a
 * compromised gateway would.
 *
 * Every public database the generator targets is checked: the live one
 * (`LIVE_PUBLIC_GRANT_TARGET`) and, since #1329, the staging twin
 * (`STAGING_PUBLIC_GRANT_TARGET`). The host provisions both on every load
 * (public-schemas.ts); neither visitor login reaches the other's tables.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  LIVE_PUBLIC_GRANT_TARGET,
  type PublicGrantTarget,
  STAGING_PUBLIC_GRANT_TARGET,
  schemaFromSpec,
  VISITOR_TABLE_PRIVILEGES,
} from "@caelo-cms/plugin-sandbox";
import { PLUGIN_TABLE_KINDS, type PluginTableKind } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { dropPluginPublicSchemas, provisionPluginPublicSchemas } from "./public-schemas.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const VISITOR_URL = process.env.PUBLIC_DATABASE_URL;
const STAGING_ADMIN_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
const STAGING_VISITOR_URL = process.env.PUBLIC_STAGING_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !VISITOR_URL || !STAGING_ADMIN_URL || !STAGING_VISITOR_URL) {
  throw new Error("DB URLs required (both public databases, see .env.example)");
}

const PLUGIN_ID = "13321332-1332-4332-8332-133213321332";
const SLUG = "t1332-kinds";
const SCHEMA = `plugin_${SLUG.replace(/-/g, "_")}`;
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

/** Each public database the generator writes grants for, with its admin and visitor logins. */
const TARGETS: ReadonlyArray<{
  target: PublicGrantTarget;
  adminUrl: string;
  visitorUrl: string;
}> = [
  { target: LIVE_PUBLIC_GRANT_TARGET, adminUrl: PUBLIC_ADMIN_URL, visitorUrl: VISITOR_URL },
  {
    target: STAGING_PUBLIC_GRANT_TARGET,
    adminUrl: STAGING_ADMIN_URL,
    visitorUrl: STAGING_VISITOR_URL,
  },
];

/** One table per kind, named after it. */
const tableOf = (kind: PluginTableKind) => kind.replace("-", "_");
const schema = Object.fromEntries(PLUGIN_TABLE_KINDS.map((k) => [tableOf(k), { note: "text" }]));
const tableKinds = Object.fromEntries(PLUGIN_TABLE_KINDS.map((k) => [tableOf(k), k]));

let adapter: DatabaseAdapter;
let stagingAdapter: DatabaseAdapter;

async function dropSchema(): Promise<void> {
  for (const { adminUrl } of TARGETS) {
    const sql = new SQL(adminUrl);
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    } finally {
      await sql.end();
    }
  }
}

beforeAll(async () => {
  await dropSchema();
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  stagingAdapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: STAGING_ADMIN_URL,
    publicDatabase: "cms_public_staging",
    expectedRoles: { admin: null, public: ["admin_role"] },
  });
});

afterAll(async () => {
  await dropSchema();
  await adapter.close();
  await stagingAdapter.close();
});

async function privilegesOf(adminUrl: string, role: string, table: string): Promise<string[]> {
  const sql = new SQL(adminUrl);
  try {
    const held: string[] = [];
    for (const p of PRIVILEGES) {
      const rows = (await sql.unsafe(
        `SELECT has_table_privilege('${role}', '"${SCHEMA}"."${table}"', '${p}') AS ok`,
      )) as { ok: boolean }[];
      if (rows[0]?.ok) held.push(p);
    }
    return held;
  } finally {
    await sql.end();
  }
}

async function provision(kinds: Record<string, PluginTableKind>, target: PublicGrantTarget) {
  const emitted = schemaFromSpec({
    pluginId: PLUGIN_ID,
    slug: SLUG,
    schema,
    tableKinds: kinds,
    indexes: undefined,
    target,
  });
  const onto = target.database === "cms_public" ? adapter : stagingAdapter;
  await onto.provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: emitted.sql });
}

/** Run `stmt` as the visitor role, scoped to the test plugin like the gateway would be. */
async function asVisitor(url: string, stmt: string): Promise<"ok" | "denied"> {
  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${PLUGIN_ID}', true)`);
      await tx.unsafe(stmt);
    });
    return "ok";
  } catch (e) {
    if (/permission denied/.test((e as Error).message)) return "denied";
    throw e;
  } finally {
    await sql.end();
  }
}

describe("table kinds → GRANTs (#1332)", () => {
  for (const { target, adminUrl, visitorUrl } of TARGETS) {
    it(`${target.database}: the visitor role holds exactly what each kind allows`, async () => {
      await provision(tableKinds, target);
      for (const kind of PLUGIN_TABLE_KINDS) {
        expect(await privilegesOf(adminUrl, target.visitorRole, tableOf(kind))).toEqual([
          ...VISITOR_TABLE_PRIVILEGES[kind],
        ]);
        expect(await privilegesOf(adminUrl, target.adminRole, tableOf(kind))).toEqual([
          ...PRIVILEGES,
        ]);
      }
    });

    it(`${target.database}: a narrowed kind takes effect on the next load`, async () => {
      // Tables provisioned before kinds existed granted the visitor all four.
      const everything = Object.fromEntries(
        Object.keys(schema).map((t) => [t, "visitor-state" as const]),
      );
      await provision(everything, target);
      expect(await privilegesOf(adminUrl, target.visitorRole, "inbox")).toEqual([...PRIVILEGES]);
      await provision(tableKinds, target);
      expect(await privilegesOf(adminUrl, target.visitorRole, "inbox")).toEqual(["INSERT"]);
      expect(await privilegesOf(adminUrl, target.visitorRole, "private")).toEqual([]);
    });

    it(`${target.database}: a compromised gateway cannot read the inbox or write what it publishes`, async () => {
      await provision(tableKinds, target);
      const t = (k: string) => `"${SCHEMA}"."${k}"`;
      expect(await asVisitor(visitorUrl, `INSERT INTO ${t("inbox")} (note) VALUES ('x')`)).toBe(
        "ok",
      );
      expect(await asVisitor(visitorUrl, `SELECT * FROM ${t("inbox")}`)).toBe("denied");
      expect(await asVisitor(visitorUrl, `DELETE FROM ${t("inbox")}`)).toBe("denied");
      expect(await asVisitor(visitorUrl, `SELECT * FROM ${t("published")}`)).toBe("ok");
      expect(
        await asVisitor(visitorUrl, `INSERT INTO ${t("published")} (note) VALUES ('forged')`),
      ).toBe("denied");
      expect(await asVisitor(visitorUrl, `UPDATE ${t("published")} SET note = 'forged'`)).toBe(
        "denied",
      );
      expect(await asVisitor(visitorUrl, `SELECT * FROM ${t("private")}`)).toBe("denied");
    });
  }
});

describe("both public databases on every load (#1329)", () => {
  const spec = { pluginId: PLUGIN_ID, slug: SLUG, schema, indexes: undefined, tableKinds };

  it("provisions the plugin's tables in both, each granted to its own visitor login only", async () => {
    await dropSchema();
    await provisionPluginPublicSchemas({ adapter, stagingAdapter }, spec);
    // Idempotent: a second load (the repair) changes nothing and succeeds.
    await provisionPluginPublicSchemas({ adapter, stagingAdapter }, spec);
    for (const { target, adminUrl } of TARGETS) {
      expect(await privilegesOf(adminUrl, target.visitorRole, "published")).toEqual(["SELECT"]);
      const other = target === LIVE_PUBLIC_GRANT_TARGET ? "public_staging_role" : "public_role";
      expect(await privilegesOf(adminUrl, other, "published")).toEqual([]);
    }
  });

  it("repairs a staging database that missed a load (an install from before it)", async () => {
    await dropSchema();
    // Only the live provisioning ran, as on an install before #1329.
    await provision(tableKinds, LIVE_PUBLIC_GRANT_TARGET);
    const t = `"${SCHEMA}"."published"`;
    await expect(asVisitor(STAGING_VISITOR_URL as string, `SELECT * FROM ${t}`)).rejects.toThrow(
      /does not exist/,
    );
    await provisionPluginPublicSchemas({ adapter, stagingAdapter }, spec);
    expect(await asVisitor(STAGING_VISITOR_URL as string, `SELECT * FROM ${t}`)).toBe("ok");
  });

  it("neither visitor login can reach the other database's tables", async () => {
    await provisionPluginPublicSchemas({ adapter, stagingAdapter }, spec);
    // The logins cannot even open the other database (#1329: CONNECT).
    const liveOnStaging = new URL(VISITOR_URL as string);
    liveOnStaging.pathname = "/cms_public_staging";
    expect(await asVisitor(liveOnStaging.toString(), "SELECT 1")).toBe("denied");
  });

  it("uninstall drops the schema in both", async () => {
    await provisionPluginPublicSchemas({ adapter, stagingAdapter }, spec);
    await dropPluginPublicSchemas({ adapter, stagingAdapter }, SCHEMA);
    for (const { adminUrl } of TARGETS) {
      const sql = new SQL(adminUrl);
      try {
        const rows = (await sql.unsafe(
          `SELECT 1 FROM information_schema.schemata WHERE schema_name = '${SCHEMA}'`,
        )) as unknown[];
        expect(rows).toHaveLength(0);
      } finally {
        await sql.end();
      }
    }
  });
});
