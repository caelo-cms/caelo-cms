// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type AuditedRole,
  assertRoleIsolation,
  evaluateRoleAudit,
  ROLE_AUDIT_NEXT_STEP,
  ROLE_AUDIT_SQL,
  type RoleAuditRow,
  roleAuditError,
  toAuditedRole,
} from "./role-audit.js";

const clean = (rolname: string, kind: AuditedRole["kind"]): AuditedRole => ({
  rolname,
  kind,
  rolsuper: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolbypassrls: false,
  rolreplication: false,
  memberOf: [],
  canConnectHere: false,
});

/** public_role exactly as the Cloud SQL Admin API leaves it (#633). */
const cloudSqlPublicRole: AuditedRole = {
  ...clean("public_role", "gateway-login"),
  rolcreaterole: true,
  rolcreatedb: true,
  memberOf: ["cloudsqlsuperuser"],
  canConnectHere: true,
};

describe("evaluateRoleAudit (#633)", () => {
  it("passes the roles as bootstrap.sh and the migrations create them", () => {
    const r = evaluateRoleAudit([
      clean("public_role", "gateway-login"),
      { ...clean("gateway_role", "gateway-login"), canConnectHere: true },
      { ...clean("operator_access_reader", "job-role"), canConnectHere: true },
      { ...clean("platform_updater", "job-role"), canConnectHere: true },
      {
        ...clean("caelo-production-upgrader@acme.iam", "job-member"),
        memberOf: ["cloudsqliamserviceaccount", "platform_updater"],
        canConnectHere: true,
      },
    ]);
    expect(r).toEqual({ violations: [], warnings: [] });
  });

  it("refuses public_role in cloudsqlsuperuser and able to open cms_admin", () => {
    const r = evaluateRoleAudit([cloudSqlPublicRole]);
    expect(r.violations).toEqual([
      "public_role is a member of cloudsqlsuperuser (it must be of none)",
      "public_role can connect to cms_admin",
    ]);
    expect(r.warnings).toEqual([
      "public_role has CREATEROLE + CREATEDB (migration 0278 could not drop it with the migration role's rights)",
    ]);
  });

  it("after the Admin API revoke only the attribute warning is left", () => {
    const r = evaluateRoleAudit([{ ...cloudSqlPublicRole, memberOf: [], canConnectHere: false }]);
    expect(r.violations).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  it("refuses any membership for the gateway logins, not only the superuser group", () => {
    const r = evaluateRoleAudit([
      { ...clean("gateway_role", "gateway-login"), memberOf: ["some_group"], canConnectHere: true },
    ]);
    expect(r.violations).toEqual(["gateway_role is a member of some_group (it must be of none)"]);
  });

  it("only public_role is refused CONNECT on cms_admin (the gateway_role login needs it)", () => {
    const r = evaluateRoleAudit([
      { ...clean("gateway_role", "gateway-login"), canConnectHere: true },
    ]);
    expect(r.violations).toEqual([]);
  });

  it("refuses SUPERUSER, BYPASSRLS and REPLICATION on every audited role", () => {
    const r = evaluateRoleAudit([
      { ...clean("platform_updater", "job-role"), rolsuper: true },
      { ...clean("operator_access_reader", "job-role"), rolbypassrls: true },
      {
        ...clean("caelo_agent", "job-member"),
        rolreplication: true,
        memberOf: ["platform_updater"],
      },
    ]);
    expect(r.violations).toEqual([
      "platform_updater has the SUPERUSER attribute",
      "operator_access_reader has the BYPASSRLS attribute",
      "caelo_agent has the REPLICATION attribute",
    ]);
  });

  it("refuses job roles and their logins in a privileged group, transitively listed", () => {
    const r = evaluateRoleAudit([
      {
        ...clean("sync@acme.iam", "job-member"),
        memberOf: ["cloudsqliamserviceaccount", "cloudsqlsuperuser", "operator_access_reader"],
      },
      { ...clean("platform_updater", "job-role"), memberOf: ["admin_role", "pg_read_all_data"] },
    ]);
    expect(r.violations).toEqual([
      "sync@acme.iam is a member of cloudsqlsuperuser",
      "platform_updater is a member of admin_role, pg_read_all_data",
    ]);
  });
});

describe("toAuditedRole", () => {
  const row: RoleAuditRow = {
    rolname: "public_role",
    kind: "gateway-login",
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolbypassrls: false,
    rolreplication: false,
    member_of: null,
    can_connect_here: false,
  };

  it("maps a row, a NULL membership list to none", () => {
    expect(toAuditedRole(row)).toEqual(clean("public_role", "gateway-login"));
  });

  it("throws on a kind the query cannot produce", () => {
    expect(() => toAuditedRole({ ...row, kind: "other" })).toThrow("unexpected kind 'other'");
  });
});

describe("ROLE_AUDIT_SQL", () => {
  it("audits the gateway logins and the job roles, never admin_role as a job member", () => {
    for (const name of [
      "public_role",
      "gateway_role",
      "operator_access_reader",
      "platform_updater",
    ]) {
      expect(ROLE_AUDIT_SQL).toContain(`'${name}'`);
    }
    expect(ROLE_AUDIT_SQL).toContain("m.rolname <> 'admin_role'");
    expect(ROLE_AUDIT_SQL).toContain("WITH RECURSIVE membership");
    expect(ROLE_AUDIT_SQL).toContain(
      "has_database_privilege(r.oid, current_database(), 'CONNECT')",
    );
  });
});

describe("assertRoleIsolation", () => {
  const rows = (r: RoleAuditRow[]) => ({ unsafe: async () => r });
  const asRow = (a: AuditedRole): RoleAuditRow => ({
    rolname: a.rolname,
    kind: a.kind,
    rolsuper: a.rolsuper,
    rolcreaterole: a.rolcreaterole,
    rolcreatedb: a.rolcreatedb,
    rolbypassrls: a.rolbypassrls,
    rolreplication: a.rolreplication,
    member_of: [...a.memberOf],
    can_connect_here: a.canConnectHere,
  });

  it("throws the violations and the next step", async () => {
    const run = assertRoleIsolation(rows([asRow(cloudSqlPublicRole)]));
    await expect(run).rejects.toThrow("public_role is a member of cloudsqlsuperuser");
    await expect(run).rejects.toThrow(ROLE_AUDIT_NEXT_STEP);
  });

  it("returns warnings when nothing breaches isolation", async () => {
    const r = await assertRoleIsolation(
      rows([asRow({ ...cloudSqlPublicRole, memberOf: [], canConnectHere: false })]),
    );
    expect(r.violations).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
});

describe("roleAuditError", () => {
  it("lists every violation", () => {
    expect(roleAuditError({ violations: ["a", "b"], warnings: [] })).toBe(
      [
        "Database role isolation check failed (issue #633, CLAUDE.md §2):",
        "  - a",
        "  - b",
        ROLE_AUDIT_NEXT_STEP,
      ].join("\n"),
    );
  });
});
