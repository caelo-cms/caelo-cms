// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LIVE_VISITOR_ROLE, retargetVisitorRole, STAGING_VISITOR_ROLE } from "./runner.js";

describe("retargetVisitorRole (#1329)", () => {
  it("swaps whole-word public_role in grants, policies and role checks", () => {
    const sql = [
      "GRANT SELECT, INSERT ON t TO public_role;",
      "CREATE POLICY p ON t FOR INSERT TO public_role WITH CHECK (true);",
      "SELECT 1 FROM pg_roles WHERE rolname = 'public_role';",
      "GRANT USAGE ON SCHEMA s TO admin_role, public_role;",
    ].join("\n");
    expect(retargetVisitorRole(sql, STAGING_VISITOR_ROLE)).toBe(
      [
        "GRANT SELECT, INSERT ON t TO public_staging_role;",
        "CREATE POLICY p ON t FOR INSERT TO public_staging_role WITH CHECK (true);",
        "SELECT 1 FROM pg_roles WHERE rolname = 'public_staging_role';",
        "GRANT USAGE ON SCHEMA s TO admin_role, public_staging_role;",
      ].join("\n"),
    );
  });

  it("leaves longer identifiers that merely contain the name alone", () => {
    const sql = "SELECT my_public_role, public_role_x, public_role$1 FROM t;";
    expect(retargetVisitorRole(sql, STAGING_VISITOR_ROLE)).toBe(sql);
  });

  it("changes nothing for the live database and refuses a non-role name", () => {
    expect(retargetVisitorRole("TO public_role", LIVE_VISITOR_ROLE)).toBe("TO public_role");
    expect(() => retargetVisitorRole("TO public_role", "x; DROP")).toThrow("is not a role name");
  });

  it("leaves no public_role in any shipped cms_public migration it retargets", () => {
    const dir = resolve(import.meta.dir, "..", "migrations", "cms_public");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      const out = retargetVisitorRole(
        readFileSync(resolve(dir, file), "utf8"),
        STAGING_VISITOR_ROLE,
      );
      expect({ file, left: /\bpublic_role\b/.test(out) }).toEqual({ file, left: false });
    }
  });
});
