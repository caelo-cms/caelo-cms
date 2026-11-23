// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_INSTALL_NAMES, prefixedInstallNames } from "@caelo-cms/shared";
import { installNameTokens, renameForInstall } from "./runner.js";

const T2 = prefixedInstallNames("t2");
const DIR = resolve(import.meta.dir, "..", "migrations");
const files = (db: "cms_admin" | "cms_public") =>
  readdirSync(resolve(DIR, db))
    .filter((f) => f.endsWith(".sql"))
    .map((file) => ({ file, sql: readFileSync(resolve(DIR, db, file), "utf8") }));

/** Whether `sql` names `word` as a whole word. */
const names = (sql: string, word: string) =>
  new RegExp(`(?<![A-Za-z0-9_$])${word}(?![A-Za-z0-9_$])`).test(sql);

describe("renameForInstall — the staging retarget (#1329)", () => {
  const staging = installNameTokens(DEFAULT_INSTALL_NAMES, "public-staging");

  it("swaps whole-word public_role in grants, policies and role checks", () => {
    const sql = [
      "GRANT SELECT, INSERT ON t TO public_role;",
      "CREATE POLICY p ON t FOR INSERT TO public_role WITH CHECK (true);",
      "SELECT 1 FROM pg_roles WHERE rolname = 'public_role';",
      "GRANT USAGE ON SCHEMA s TO admin_role, public_role;",
    ].join("\n");
    expect(renameForInstall(sql, staging)).toBe(
      [
        "GRANT SELECT, INSERT ON t TO public_staging_role;",
        "CREATE POLICY p ON t FOR INSERT TO public_staging_role WITH CHECK (true);",
        "SELECT 1 FROM pg_roles WHERE rolname = 'public_staging_role';",
        "GRANT USAGE ON SCHEMA s TO admin_role, public_staging_role;",
      ].join("\n"),
    );
  });

  it("leaves longer identifiers that merely contain the name alone", () => {
    const sql =
      "SELECT my_public_role, public_role_x, public_role$1, caelo_grant_platform_updater() FROM t;";
    expect(renameForInstall(sql, staging)).toBe(sql);
  });

  it("changes nothing for the live database with today's names", () => {
    expect(
      renameForInstall("TO public_role", installNameTokens(DEFAULT_INSTALL_NAMES, "public")),
    ).toBe("TO public_role");
  });

  it("leaves no public_role in any shipped cms_public migration it retargets", () => {
    for (const { file, sql } of files("cms_public")) {
      const out = renameForInstall(sql, staging);
      expect({ file, left: names(out, "public_role") }).toEqual({ file, left: false });
    }
  });
});

describe("renameForInstall — an install's own names (#1689)", () => {
  it("renames every role and database, once, in one pass", () => {
    const sql =
      "GRANT CONNECT ON DATABASE cms_admin TO platform_updater; ALTER DATABASE cms_public SET x = 1; REVOKE ALL ON DATABASE cms_public_staging FROM public_role; DROP OWNED BY gateway_role;";
    expect(renameForInstall(sql, installNameTokens(T2, "admin"))).toBe(
      "GRANT CONNECT ON DATABASE t2_cms_admin TO t2_platform_updater; ALTER DATABASE t2_cms_public SET x = 1; REVOKE ALL ON DATABASE t2_cms_public_staging FROM t2_public_role; DROP OWNED BY t2_gateway_role;",
    );
  });

  it("retargets the visitor login to the install's staging login in the staging run", () => {
    expect(
      renameForInstall("TO public_role, admin_role", installNameTokens(T2, "public-staging")),
    ).toBe("TO t2_public_staging_role, t2_admin_role");
  });

  it("never renames a replacement again (a map that swaps two names)", () => {
    const swapped = new Map([
      ["admin_role", "public_role"],
      ["public_role", "admin_role"],
    ]);
    expect(renameForInstall("TO admin_role, public_role", swapped)).toBe(
      "TO public_role, admin_role",
    );
  });

  it("refuses a replacement that is not an identifier", () => {
    expect(() => renameForInstall("TO admin_role", new Map([["admin_role", "x; DROP"]]))).toThrow(
      "is not a role or database name",
    );
  });

  it("leaves no written name in any shipped migration of either database", () => {
    const written = [
      ...Object.values(DEFAULT_INSTALL_NAMES.roles),
      ...Object.values(DEFAULT_INSTALL_NAMES.databases),
    ];
    for (const [db, target] of [
      ["cms_admin", "admin"],
      ["cms_public", "public"],
      ["cms_public", "public-staging"],
    ] as const) {
      for (const { file, sql } of files(db)) {
        const out = renameForInstall(sql, installNameTokens(T2, target));
        const left = written.filter((w) => names(out, w));
        expect({ file, target, left }).toEqual({ file, target, left: [] });
      }
    }
  });
});
