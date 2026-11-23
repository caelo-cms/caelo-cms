// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 guardrail (c), runtime half: the plugin schema DDL the admin
 * runs at every boot grants only through `grantStatement`, which refuses
 * any role outside the database's allowed set. The migration grant lint
 * cannot see this DDL; this test is its twin. Since #1689 the allowed set
 * is the install's own roles: a plugin of install B grants nothing to
 * install A's roles on a shared Postgres server.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_INSTALL_NAMES, prefixedInstallNames } from "@caelo-cms/shared";
import {
  adminGrantTarget,
  adminSchemaFromSpec,
  grantStatement,
  type PluginSchemaDatabase,
  type PluginSchemaRoles,
  pluginSchemaGrantees,
  publicGrantTargets,
  schemaFromSpec,
} from "./schema.js";

/** Every GRANT statement in `sql`, as `{ privileges, grantee }`. */
function grants(sql: string): { privileges: string; grantee: string }[] {
  return [
    ...sql.matchAll(/\bGRANT\s+([\s\S]*?)\s+ON\s[^;]*?\bTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g),
  ].map((m) => ({ privileges: m[1] as string, grantee: m[2] as string }));
}

const SPEC = {
  pluginId: "11111111-1111-4111-8111-111111111111",
  slug: "probe",
};
const TABLE = '"plugin_probe"."t"';
const DEFAULT_ROLES = DEFAULT_INSTALL_NAMES.roles;
const TARGETS = publicGrantTargets(DEFAULT_ROLES);
const ADMIN = adminGrantTarget(DEFAULT_ROLES);

describe("grantStatement (#635)", () => {
  it("refuses public_role, the former gateway_role, PUBLIC and unknown roles in cms_admin", () => {
    for (const grantee of [
      "public_role",
      "gateway_role",
      "PUBLIC",
      "postgres",
      "pg_read_all_data",
    ]) {
      expect(() => grantStatement(ADMIN, "SELECT (id)", TABLE, grantee)).toThrow(
        /refusing to GRANT/,
      );
    }
  });

  it("refuses roles outside the cms_public set", () => {
    for (const grantee of ["gateway_role", "PUBLIC", "pg_read_all_data", "public_staging_role"]) {
      expect(() => grantStatement(TARGETS.live, "SELECT (id)", TABLE, grantee)).toThrow(
        /refusing to GRANT/,
      );
    }
  });

  it("refuses the live gateway's login, and everyone but the staging one and the admin, in cms_public_staging (#1329)", () => {
    for (const grantee of ["public_role", "gateway_role", "PUBLIC", "pg_read_all_data"]) {
      expect(() => grantStatement(TARGETS.staging, "SELECT (id)", TABLE, grantee)).toThrow(
        /refusing to GRANT/,
      );
    }
    expect(grantStatement(TARGETS.staging, "SELECT", TABLE, "public_staging_role")).toBe(
      `GRANT SELECT ON ${TABLE} TO public_staging_role;`,
    );
  });

  it("refuses a role name that is not a plain identifier (#1689)", () => {
    const roles: PluginSchemaRoles = { ...DEFAULT_ROLES, public: "x; DROP" };
    expect(() => publicGrantTargets(roles)).toThrow("is not a role name");
  });
});

describe("plugin schema DDL grants (#635)", () => {
  const ddl = (roles: PluginSchemaRoles): [PluginSchemaDatabase, string][] => {
    const targets = publicGrantTargets(roles);
    return [
      [
        "cms_public",
        schemaFromSpec({
          tableKinds: { comments: "visitor-state", votes: "visitor-state" },
          ...SPEC,
          schema: { comments: { body: "text" }, votes: { n: "int" } },
          indexes: undefined,
          target: targets.live,
        }).sql,
      ],
      [
        "cms_public_staging",
        schemaFromSpec({
          tableKinds: { comments: "inbox", votes: "visitor-state" },
          ...SPEC,
          schema: { comments: { body: "text" }, votes: { n: "int" } },
          indexes: undefined,
          target: targets.staging,
        }).sql,
      ],
      [
        "cms_admin",
        adminSchemaFromSpec({
          ...SPEC,
          adminSchema: { settings: { label: "string" }, approved: { digest: "text" } },
          projectedTables: ["settings"],
          indexes: undefined,
          target: adminGrantTarget(roles),
        }).sql,
      ],
    ];
  };

  for (const [database, sql] of ddl(DEFAULT_ROLES)) {
    it(`${database}: every emitted GRANT goes to an allowed role`, () => {
      const found = grants(sql);
      expect(found.length).toBeGreaterThan(0);
      for (const { grantee } of found) {
        expect(pluginSchemaGrantees(DEFAULT_ROLES)[database].has(grantee)).toBe(true);
      }
    });
  }

  it("an install with its own names grants to its own roles only (#1689)", () => {
    const roles = prefixedInstallNames("t2").roles;
    for (const [database, sql] of ddl(roles)) {
      const grantees = new Set(grants(sql).map((g) => g.grantee));
      expect({ database, grantees: [...grantees].sort() }).toEqual({
        database,
        grantees: [...pluginSchemaGrantees(roles)[database]].sort(),
      });
      for (const name of Object.values(DEFAULT_ROLES)) {
        expect(sql).not.toMatch(new RegExp(`(?<![a-z0-9_])${name}(?![a-z0-9_])`));
      }
    }
  });

  it("the emitters write no GRANT except through grantStatement", () => {
    const source = readFileSync(resolve(import.meta.dir, "schema.ts"), "utf8");
    const literalGrants = source
      .split("\n")
      .filter((line) => /[`"']\s*GRANT\b/.test(line) && !line.trimStart().startsWith("*"));
    expect(literalGrants).toHaveLength(1);
    expect(literalGrants[0]).toMatch(
      /^ {2}return `GRANT \$\{privileges\} ON \$\{object\} TO \$\{roleIdent\(grantee\)\};`;$/,
    );
  });
});
