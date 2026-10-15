// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 guardrail (c), runtime half: the plugin schema DDL the admin
 * runs at every boot grants only through `grantStatement`, which refuses
 * any role outside the database's allowed set. The migration grant lint
 * cannot see this DDL; this test is its twin.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  adminSchemaFromSpec,
  grantStatement,
  LEGACY_READ_ONLY_GRANTEES,
  PLUGIN_SCHEMA_GRANTEES,
  type PluginSchemaDatabase,
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

describe("grantStatement (#635)", () => {
  it("refuses public_role, PUBLIC and unknown roles in cms_admin", () => {
    for (const grantee of ["public_role", "PUBLIC", "postgres", "pg_read_all_data"]) {
      expect(() => grantStatement("cms_admin", "SELECT (id)", TABLE, grantee)).toThrow(
        /refusing to GRANT/,
      );
    }
  });

  it("allows the former gateway_role only USAGE and column SELECT in cms_admin", () => {
    expect(grantStatement("cms_admin", "SELECT (id, label)", TABLE, "gateway_role")).toBe(
      `GRANT SELECT (id, label) ON ${TABLE} TO gateway_role;`,
    );
    expect(grantStatement("cms_admin", "USAGE", 'SCHEMA "plugin_probe"', "gateway_role")).toContain(
      "TO gateway_role",
    );
    for (const privileges of [
      "SELECT",
      "SELECT, INSERT",
      "INSERT",
      "UPDATE (label)",
      "ALL",
      "SELECT (id), DELETE",
      "USAGE, CREATE",
    ]) {
      expect(() => grantStatement("cms_admin", privileges, TABLE, "gateway_role")).toThrow(
        /refusing to GRANT/,
      );
    }
  });

  it("refuses roles outside the cms_public set", () => {
    for (const grantee of ["gateway_role", "PUBLIC", "pg_read_all_data"]) {
      expect(() => grantStatement("cms_public", "SELECT (id)", TABLE, grantee)).toThrow(
        /refusing to GRANT/,
      );
    }
  });
});

describe("plugin schema DDL grants (#635)", () => {
  const cases: [PluginSchemaDatabase, string][] = [
    [
      "cms_public",
      schemaFromSpec({ ...SPEC, schema: { comments: { body: "text" }, votes: { n: "int" } } }).sql,
    ],
    [
      "cms_admin",
      adminSchemaFromSpec({
        ...SPEC,
        adminSchema: { settings: { label: "string" }, approved: { digest: "text" } },
        visitorReadable: true,
        projectedTables: ["settings"],
      }).sql,
    ],
  ];

  for (const [database, sql] of cases) {
    it(`${database}: every emitted GRANT goes to an allowed role`, () => {
      const found = grants(sql);
      expect(found.length).toBeGreaterThan(0);
      for (const { privileges, grantee } of found) {
        if (PLUGIN_SCHEMA_GRANTEES[database].has(grantee)) continue;
        expect(LEGACY_READ_ONLY_GRANTEES[database].has(grantee)).toBe(true);
        expect(privileges).toMatch(/^(?:USAGE|SELECT \([^()]+\))$/);
      }
    });
  }

  it("the emitters write no GRANT except through grantStatement", () => {
    const source = readFileSync(resolve(import.meta.dir, "schema.ts"), "utf8");
    const literalGrants = source
      .split("\n")
      .filter((line) => /[`"']\s*GRANT\b/.test(line) && !line.trimStart().startsWith("*"));
    expect(literalGrants).toHaveLength(1);
    expect(literalGrants[0]).toMatch(
      /^ {2}return `GRANT \$\{privileges\} ON \$\{object\} TO \$\{grantee\};`;$/,
    );
  });
});
