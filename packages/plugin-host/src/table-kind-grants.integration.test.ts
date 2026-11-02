// SPDX-License-Identifier: MPL-2.0

/**
 * #1332 (E10) — the table kinds are enforced by Postgres, not only by the
 * host: the visitor role holds exactly the privileges each kind allows
 * (plugin-sandbox `VISITOR_TABLE_PRIVILEGES`), the admin role all four.
 * The public side is assumed compromised (docs/dev/public-admin-boundary.md),
 * so the test also connects AS the visitor role and tries what a
 * compromised gateway would.
 *
 * Every public database the generator targets is checked; today that is
 * the live one (`LIVE_PUBLIC_GRANT_TARGET`). The staging database (#1329)
 * adds its target to `TARGETS`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  LIVE_PUBLIC_GRANT_TARGET,
  type PublicGrantTarget,
  schemaFromSpec,
  VISITOR_TABLE_PRIVILEGES,
} from "@caelo-cms/plugin-sandbox";
import { PLUGIN_TABLE_KINDS, type PluginTableKind } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const VISITOR_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !VISITOR_URL) throw new Error("DB URLs required");

const PLUGIN_ID = "13321332-1332-4332-8332-133213321332";
const SLUG = "t1332-kinds";
const SCHEMA = `plugin_${SLUG.replace(/-/g, "_")}`;
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

/** Each public database the generator writes grants for, with a login of its visitor role. */
const TARGETS: ReadonlyArray<{ target: PublicGrantTarget; visitorUrl: string }> = [
  { target: LIVE_PUBLIC_GRANT_TARGET, visitorUrl: VISITOR_URL },
];

/** One table per kind, named after it. */
const tableOf = (kind: PluginTableKind) => kind.replace("-", "_");
const schema = Object.fromEntries(PLUGIN_TABLE_KINDS.map((k) => [tableOf(k), { note: "text" }]));
const tableKinds = Object.fromEntries(PLUGIN_TABLE_KINDS.map((k) => [tableOf(k), k]));

let adapter: DatabaseAdapter;

async function dropSchema(): Promise<void> {
  const sql = new SQL(PUBLIC_ADMIN_URL as string);
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await dropSchema();
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
});

afterAll(async () => {
  await dropSchema();
  await adapter.close();
});

async function privilegesOf(role: string, table: string): Promise<string[]> {
  const sql = new SQL(PUBLIC_ADMIN_URL as string);
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
  await adapter.provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: emitted.sql });
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
  for (const { target, visitorUrl } of TARGETS) {
    it(`${target.database}: the visitor role holds exactly what each kind allows`, async () => {
      await provision(tableKinds, target);
      for (const kind of PLUGIN_TABLE_KINDS) {
        expect(await privilegesOf(target.visitorRole, tableOf(kind))).toEqual([
          ...VISITOR_TABLE_PRIVILEGES[kind],
        ]);
        expect(await privilegesOf(target.adminRole, tableOf(kind))).toEqual([...PRIVILEGES]);
      }
    });

    it(`${target.database}: a narrowed kind takes effect on the next load`, async () => {
      // Tables provisioned before kinds existed granted the visitor all four.
      const everything = Object.fromEntries(
        Object.keys(schema).map((t) => [t, "visitor-state" as const]),
      );
      await provision(everything, target);
      expect(await privilegesOf(target.visitorRole, "inbox")).toEqual([...PRIVILEGES]);
      await provision(tableKinds, target);
      expect(await privilegesOf(target.visitorRole, "inbox")).toEqual(["INSERT"]);
      expect(await privilegesOf(target.visitorRole, "private")).toEqual([]);
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
