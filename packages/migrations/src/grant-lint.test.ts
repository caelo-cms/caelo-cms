// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 guardrail (c): no migration may open a path from the public
 * side into cms_admin. Static, so it fails in CI before any database sees
 * the migration (the post-migration role audit is the runtime twin):
 *
 *   - a cms_admin migration never GRANTs anything to public_role or PUBLIC
 *     (REVOKE … FROM PUBLIC is fine), nor to gateway_role after the
 *     migration that made the gateway public-only (0281);
 *   - no migration in either database installs a bridge between databases
 *     (dblink, postgres_fdw, a foreign server or user mapping);
 *   - a grantee the lint cannot read — computed at run time (`format('… TO
 *     %I', r)`, `'… TO ' || r`, `quote_ident(…)`) — fails closed: the line
 *     must carry `-- caelo:dynamic-grantee <reason>` (on the GRANT's line or
 *     the line above), so a reviewer reads why the role set is safe.
 *
 * The plugin schema DDL the admin runs at boot is checked by its own test
 * (plugin-sandbox `schema-grants.test.ts`).
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(import.meta.dir, "..", "migrations");

/** Migrations up to this one still grant gateway_role; nothing after may. */
const LAST_GATEWAY_ROLE_GRANT = 281;

function migrations(db: "cms_admin" | "cms_public"): { file: string; sql: string }[] {
  return readdirSync(resolve(DIR, db))
    .filter((f) => f.endsWith(".sql"))
    .map((file) => ({ file, sql: readFileSync(resolve(DIR, db, file), "utf8") }));
}

/** SQL statements without `--` comments, whitespace collapsed. */
function statements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Every GRANT statement in `sql` whose grantee list names `grantee`. */
function grantsTo(sql: string, grantee: RegExp): string[] {
  return statements(sql).filter((s) => {
    const m = /\bGRANT\b[\s\S]*?\bTO\b([\s\S]*)$/i.exec(s);
    return m?.[1] !== undefined && grantee.test(m[1]);
  });
}

/** A grantee written as something other than a role name. */
const DYNAMIC_GRANTEE = /%[ILs]|\|\||\bquote_ident\s*\(|\bformat\s*\(/i;

const ANNOTATION = /--\s*caelo:dynamic-grantee\s+\S/;

/**
 * Every GRANT in `sql` whose grantee is computed at run time and carries no
 * `caelo:dynamic-grantee` annotation, as `line N: statement`.
 */
function unannotatedDynamicGrants(sql: string): string[] {
  const raw = sql.split("\n");
  // Blank out comments but keep offsets, so a match maps back to its line.
  const code = raw.map((line) => line.replace(/--[^\n]*/, (c) => " ".repeat(c.length))).join("\n");
  const out: string[] = [];
  for (const m of code.matchAll(/\bGRANT\b[^;]*?\bTO\b([^;]*)/gi)) {
    if (!DYNAMIC_GRANTEE.test(m[1] ?? "")) continue;
    const line = code.slice(0, m.index).split("\n").length - 1;
    const annotated = [raw[line], raw[line - 1]].some((l) => l !== undefined && ANNOTATION.test(l));
    if (!annotated) out.push(`line ${line + 1}: ${m[0].replace(/\s+/g, " ").slice(0, 160)}`);
  }
  return out;
}

const BRIDGE =
  /\bCREATE\s+(EXTENSION\s+(IF\s+NOT\s+EXISTS\s+)?"?(dblink|postgres_fdw)\b|FOREIGN\s+DATA\s+WRAPPER\b|SERVER\b|USER\s+MAPPING\b)/i;

describe("migration grant lint (#635)", () => {
  it("finds a grant in the shapes migrations write (self-test)", () => {
    expect(grantsTo("GRANT SELECT (a, b) ON t TO public_role;", /\bpublic_role\b/)).toHaveLength(1);
    expect(grantsTo("REVOKE ALL ON t FROM public_role;", /\bpublic_role\b/)).toHaveLength(0);
    expect(grantsTo("-- GRANT SELECT ON t TO public_role", /\bpublic_role\b/)).toHaveLength(0);
    expect(BRIDGE.test("CREATE EXTENSION IF NOT EXISTS dblink")).toBe(true);
  });

  it("flags a computed grantee unless annotated (self-test, review finding)", () => {
    for (const sql of [
      "EXECUTE format('GRANT SELECT ON t TO %I', r);",
      "EXECUTE 'GRANT SELECT ON t TO ' || r;",
      "EXECUTE 'GRANT CONNECT ON DATABASE cms_admin TO ' || quote_ident(r);",
      "DO $$ BEGIN\n  EXECUTE format('GRANT USAGE ON SCHEMA s TO %s', role_name);\nEND $$;",
    ]) {
      expect(unannotatedDynamicGrants(sql)).toHaveLength(1);
    }
    expect(
      unannotatedDynamicGrants(
        "-- caelo:dynamic-grantee r is one of the literal roles above\nEXECUTE format('GRANT SELECT ON t TO %I', r);",
      ),
    ).toEqual([]);
    // A bare marker without a reason does not count.
    expect(
      unannotatedDynamicGrants(
        "-- caelo:dynamic-grantee\nEXECUTE format('GRANT SELECT ON t TO %I', r);",
      ),
    ).toHaveLength(1);
    // A computed object with a literal grantee is readable.
    expect(
      unannotatedDynamicGrants("EXECUTE format('GRANT SELECT ON %I TO public_role', t);"),
    ).toEqual([]);
  });

  it("every computed grantee in any migration is annotated", () => {
    const offenders = [...migrations("cms_admin"), ...migrations("cms_public")].flatMap(
      ({ file, sql }) => unannotatedDynamicGrants(sql).map((s) => `${file} ${s}`),
    );
    expect(offenders).toEqual([]);
  });

  it("no cms_admin migration grants anything to public_role or PUBLIC", () => {
    const offenders = migrations("cms_admin").flatMap(({ file, sql }) =>
      grantsTo(sql, /\b(public_role|PUBLIC)\b/i).map((s) => `${file}: ${s.slice(0, 160)}`),
    );
    expect(offenders).toEqual([]);
  });

  it("no cms_admin migration after 0281 grants anything to gateway_role", () => {
    const offenders = migrations("cms_admin")
      .filter(({ file }) => Number.parseInt(file, 10) > LAST_GATEWAY_ROLE_GRANT)
      .flatMap(({ file, sql }) =>
        grantsTo(sql, /\bgateway_role\b/i).map((s) => `${file}: ${s.slice(0, 160)}`),
      );
    expect(offenders).toEqual([]);
  });

  it("no migration installs a bridge between the databases", () => {
    const offenders = [...migrations("cms_admin"), ...migrations("cms_public")].flatMap(
      ({ file, sql }) =>
        statements(sql)
          .filter((s) => BRIDGE.test(s))
          .map((s) => `${file}: ${s}`),
    );
    expect(offenders).toEqual([]);
  });
});
