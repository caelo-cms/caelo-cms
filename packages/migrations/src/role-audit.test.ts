// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_INSTALL_NAMES,
  GATEWAY_ROLE_CONNECTION_LIMIT,
  prefixedInstallNames,
} from "@caelo-cms/shared";
import { assertNoRlsPolicyDrift, evaluateRlsDrift, RLS_DRIFT_SQL } from "./rls.js";
import {
  type AuditedRole,
  assertNoForeignReferences,
  assertRoleIsolation,
  type CrossDatabaseGrantRow,
  type CrossInstallConnectRow,
  crossDatabaseGrantsSql,
  crossInstallConnectSql,
  crossInstallConnectViolations,
  evaluateRoleAudit,
  foreignReferencesSql,
  PUBLIC_ROLE_LIMITS,
  publicConnectSql,
  publicConnectViolations,
  ROLE_AUDIT_NEXT_STEP,
  type RoleAuditRow,
  roleAuditError,
  roleAuditSql,
  toAuditedRole,
} from "./role-audit.js";

const D = DEFAULT_INSTALL_NAMES;
const ROLE_AUDIT_SQL = roleAuditSql(D);
const PUBLIC_CONNECT_SQL = publicConnectSql(D);

const PUBLIC_ROLE_SET = {
  connectionLimit: PUBLIC_ROLE_LIMITS.connectionLimit,
  settings: Object.entries(PUBLIC_ROLE_LIMITS.settings).map(([k, v]) => `${k}=${v}`),
};

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
  // #1329 — each gateway login reaches its own public database.
  publicDatabases:
    rolname === "public_role"
      ? ["cms_public"]
      : rolname === "public_staging_role"
        ? ["cms_public_staging"]
        : [],
  // #1338 — public_role as bootstrap.sh / migration 0500 leave it (#1329:
  // public_staging_role as bootstrap.sh / migration 0530 leave it).
  ...(rolname === "public_role" || rolname === "public_staging_role"
    ? PUBLIC_ROLE_SET
    : { connectionLimit: -1, settings: [] }),
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
    const r = evaluateRoleAudit(D, [
      clean("public_role", "gateway-login"),
      clean("public_staging_role", "gateway-login"),
      // #635 — a former gateway_role the migration role could not drop.
      clean("gateway_role", "gateway-login"),
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
    const r = evaluateRoleAudit(D, [cloudSqlPublicRole]);
    expect(r.violations).toEqual([
      "public_role is a member of cloudsqlsuperuser (it must be of none)",
      "public_role can connect to cms_admin",
    ]);
    expect(r.warnings).toEqual([
      "public_role has CREATEROLE + CREATEDB (migration 0278 could not drop it with the migration role's rights)",
    ]);
  });

  it("after the Admin API revoke only the attribute warning is left", () => {
    const r = evaluateRoleAudit(D, [
      { ...cloudSqlPublicRole, memberOf: [], canConnectHere: false },
    ]);
    expect(r.violations).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  it("refuses any membership for the gateway logins, not only the superuser group", () => {
    const r = evaluateRoleAudit(D, [
      { ...clean("gateway_role", "gateway-login"), memberOf: ["some_group"] },
    ]);
    expect(r.violations).toEqual(["gateway_role is a member of some_group (it must be of none)"]);
  });

  it("refuses CONNECT on cms_admin to the former gateway_role too (#635)", () => {
    const r = evaluateRoleAudit(D, [
      { ...clean("gateway_role", "gateway-login"), canConnectHere: true },
    ]);
    expect(r.violations).toEqual(["gateway_role can connect to cms_admin"]);
  });

  it("refuses SUPERUSER, BYPASSRLS and REPLICATION on every audited role", () => {
    const r = evaluateRoleAudit(D, [
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
    const r = evaluateRoleAudit(D, [
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

describe("the staging gateway's login (#1329)", () => {
  it("refuses either gateway login on the other environment's database", () => {
    const r = evaluateRoleAudit(D, [
      {
        ...clean("public_role", "gateway-login"),
        publicDatabases: ["cms_public", "cms_public_staging"],
      },
      {
        ...clean("public_staging_role", "gateway-login"),
        publicDatabases: ["cms_public", "cms_public_staging"],
      },
      { ...clean("gateway_role", "gateway-login"), publicDatabases: ["cms_public_staging"] },
    ]);
    expect(r.violations).toEqual([
      "public_role can connect to cms_public_staging",
      "public_staging_role can connect to cms_public",
      "gateway_role can connect to cms_public_staging",
    ]);
  });

  it("refuses the staging login in a group, on cms_admin, or without its limits", () => {
    const r = evaluateRoleAudit(D, [
      {
        ...clean("public_staging_role", "gateway-login"),
        memberOf: ["cloudsqlsuperuser"],
        canConnectHere: true,
        connectionLimit: -1,
      },
    ]);
    expect(r.violations.map((v) => v.split(" (")[0])).toEqual([
      "public_staging_role is a member of cloudsqlsuperuser",
      "public_staging_role can connect to cms_admin",
      "public_staging_role has CONNECTION LIMIT -1",
    ]);
  });

  it("asks which public databases each login may open, and whether PUBLIC may", () => {
    expect(ROLE_AUDIT_SQL).toContain("'public_staging_role'");
    expect(ROLE_AUDIT_SQL).toContain("d.datname IN ('cms_public', 'cms_public_staging')");
    expect(PUBLIC_CONNECT_SQL).toContain(
      "d.datname IN ('cms_admin', 'cms_public', 'cms_public_staging')",
    );
    expect(PUBLIC_CONNECT_SQL).toContain("has_database_privilege('public', d.oid, 'CONNECT')");
    expect(publicConnectViolations([{ datname: "cms_public_staging" }])[0]).toStartWith(
      "PUBLIC may connect to cms_public_staging",
    );
  });

  it("bootstrap.sh and migration 0530 set the staging login's limits", async () => {
    const root = new URL("../", import.meta.url);
    // bootstrap.sh names the login through the install's map (#1689).
    for (const [path, role] of [
      ["src/bootstrap.sh", `\${STAGING_ROLE}`],
      ["migrations/cms_admin/0530_public_staging_database.sql", "public_staging_role"],
    ] as const) {
      const text = await Bun.file(new URL(path, root)).text();
      expect(text).toContain(
        `ALTER ROLE ${role} CONNECTION LIMIT ${PUBLIC_ROLE_LIMITS.connectionLimit};`,
      );
      for (const [k, v] of Object.entries(PUBLIC_ROLE_LIMITS.settings)) {
        expect(text).toContain(`ALTER ROLE ${role} SET ${k} = '${v}';`);
      }
    }
  });
});

describe("public_role database limits (#1338)", () => {
  it("refuses public_role without its connection limit and settings", () => {
    const r = evaluateRoleAudit(D, [
      { ...clean("public_role", "gateway-login"), connectionLimit: -1, settings: [] },
    ]);
    expect(r.violations).toHaveLength(4);
    expect(r.violations[0]).toStartWith(
      "public_role has CONNECTION LIMIT -1 (it must be 30; set by cms_admin migration 0500",
    );
    expect(r.violations.slice(1).map((v) => v.split(" (")[0])).toEqual([
      "public_role has statement_timeout unset",
      "public_role has idle_in_transaction_session_timeout unset",
      "public_role has work_mem unset",
    ]);
  });

  it("refuses a weaker value, and leaves the former gateway_role alone", () => {
    const r = evaluateRoleAudit(D, [
      {
        ...clean("public_role", "gateway-login"),
        settings: PUBLIC_ROLE_SET.settings.map((s) =>
          s.startsWith("statement_timeout=") ? "statement_timeout=0" : s,
        ),
      },
      clean("gateway_role", "gateway-login"),
    ]);
    expect(r.violations).toEqual([
      "public_role has statement_timeout = 0 (it must be 5s; set by cms_admin migration 0500 or packages/migrations/src/bootstrap.sh (self-hosted: `cms-provision upgrade` re-runs it))",
    ]);
  });

  it("is the limit the pool budget refuses to exceed", () => {
    expect(PUBLIC_ROLE_LIMITS.connectionLimit).toBe(GATEWAY_ROLE_CONNECTION_LIMIT);
  });

  it("asks the database for both", () => {
    expect(ROLE_AUDIT_SQL).toContain("r.rolconnlimit AS connection_limit");
    expect(ROLE_AUDIT_SQL).toContain("COALESCE(r.rolconfig, ARRAY[]::text[]) AS settings");
  });

  it("bootstrap.sh and migration 0500 set exactly these values", async () => {
    const root = new URL("../", import.meta.url);
    for (const [path, role] of [
      ["src/bootstrap.sh", `\${PUBLIC_ROLE}`],
      ["migrations/cms_admin/0500_gateway_role_limits_live_origins.sql", "public_role"],
    ] as const) {
      const text = await Bun.file(new URL(path, root)).text();
      expect(text).toContain(
        `ALTER ROLE ${role} CONNECTION LIMIT ${PUBLIC_ROLE_LIMITS.connectionLimit};`,
      );
      for (const [k, v] of Object.entries(PUBLIC_ROLE_LIMITS.settings)) {
        expect(text).toContain(`ALTER ROLE ${role} SET ${k} = '${v}';`);
      }
    }
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
    public_databases: ["cms_public"],
    connection_limit: PUBLIC_ROLE_SET.connectionLimit,
    settings: PUBLIC_ROLE_SET.settings,
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
  const rows = (
    r: RoleAuditRow[],
    grants: CrossDatabaseGrantRow[] = [],
    openDatabases: { datname: string }[] = [],
    crossInstall: CrossInstallConnectRow[] = [],
  ) => ({
    unsafe: async (q: string) => {
      if (q === ROLE_AUDIT_SQL) return r;
      if (q === PUBLIC_CONNECT_SQL) return openDatabases;
      if (q === crossInstallConnectSql(D)) return crossInstall;
      if (q === crossDatabaseGrantsSql(D)) return grants;
      throw new Error(`unexpected audit query: ${q.slice(0, 80)}`);
    },
  });
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
    public_databases: [...a.publicDatabases],
    connection_limit: a.connectionLimit,
    settings: [...a.settings],
  });

  it("throws the violations and the next step", async () => {
    const run = assertRoleIsolation(rows([asRow(cloudSqlPublicRole)]), D);
    await expect(run).rejects.toThrow("public_role is a member of cloudsqlsuperuser");
    await expect(run).rejects.toThrow(ROLE_AUDIT_NEXT_STEP);
  });

  it("fails on any cms_admin privilege the public side holds (#635)", async () => {
    const run = assertRoleIsolation(
      rows([], [{ rolname: "public_role", object: "table pages" }]),
      D,
    );
    await expect(run).rejects.toThrow(
      "public_role holds a privilege on cms_admin table pages (the public side must reach no authoring object)",
    );
  });

  it("fails while PUBLIC may connect to a public database (#1329)", async () => {
    const run = assertRoleIsolation(rows([], [], [{ datname: "cms_public_staging" }]), D);
    await expect(run).rejects.toThrow("PUBLIC may connect to cms_public_staging");
  });

  it("fails while a role of the install may connect to another install's database (#1689)", async () => {
    const run = assertRoleIsolation(
      rows([], [], [], [{ rolname: "admin_role", datname: "t2_cms_admin" }]),
      D,
    );
    await expect(run).rejects.toThrow(
      "admin_role can connect to t2_cms_admin, a database of another install",
    );
  });

  it("returns warnings when nothing breaches isolation", async () => {
    const r = await assertRoleIsolation(
      rows([asRow({ ...cloudSqlPublicRole, memberOf: [], canConnectHere: false })]),
      D,
    );
    expect(r.violations).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
});

describe("an install with its own names (#1689)", () => {
  const T2 = prefixedInstallNames("t2");

  it("audits the install's own logins and databases", () => {
    const sql = roleAuditSql(T2);
    for (const name of ["t2_public_role", "t2_gateway_role", "t2_platform_updater"]) {
      expect(sql).toContain(`'${name}'`);
    }
    expect(sql).toContain("m.rolname <> 't2_admin_role'");
    expect(sql).toContain("d.datname IN ('t2_cms_public', 't2_cms_public_staging')");
    expect(sql).not.toMatch(/'(admin_role|public_role|cms_public)'/);
    expect(publicConnectSql(T2)).toContain(
      "d.datname IN ('t2_cms_admin', 't2_cms_public', 't2_cms_public_staging')",
    );
  });

  it("judges the install's logins against its own databases", () => {
    const login = (rolname: string, publicDatabases: string[]): AuditedRole => ({
      ...clean(rolname, "gateway-login"),
      ...PUBLIC_ROLE_SET,
      publicDatabases,
    });
    expect(
      evaluateRoleAudit(T2, [
        login("t2_public_role", ["t2_cms_public"]),
        login("t2_public_staging_role", ["t2_cms_public_staging"]),
      ]).violations,
    ).toEqual([]);
    expect(
      evaluateRoleAudit(T2, [
        {
          ...login("t2_public_role", ["t2_cms_public", "t2_cms_public_staging"]),
          canConnectHere: true,
        },
      ]).violations,
    ).toEqual([
      "t2_public_role can connect to t2_cms_admin",
      "t2_public_role can connect to t2_cms_public_staging",
    ]);
  });

  it("names another install's database by what it is", () => {
    expect(
      crossInstallConnectViolations([{ rolname: "t2_admin_role", datname: "cms_admin" }]),
    ).toEqual([
      "t2_admin_role can connect to cms_admin, a database of another install (#1689: an install's roles reach its own databases only; revoke the CONNECT or the membership that carries it)",
    ]);
  });

  it("finds another install's roles by the databases they reach, not by their names", () => {
    const sql = foreignReferencesSql(T2);
    expect(sql).toContain("FROM pg_shdepend d");
    expect(sql).toContain("NOT has_database_privilege('public', d.oid, 'CONNECT')");
    expect(sql).toContain("NOT r.rolsuper");
    expect(sql).toContain(
      "d.datname NOT IN ('t2_cms_admin', 't2_cms_public', 't2_cms_public_staging')",
    );
  });

  it("refuses a foreign reference with the role, the object and the database", async () => {
    const run = assertNoForeignReferences(
      {
        unsafe: async () => [{ rolname: "public_role", what: "holds a privilege on table pages" }],
      },
      "cms_admin",
      T2,
    );
    await expect(run).rejects.toThrow(
      "public_role, a role of another install, holds a privilege on table pages in t2_cms_admin",
    );
  });

  it("refuses a hand-built map with a name that is not an identifier", () => {
    const bad = { ...T2, roles: { ...T2.roles, admin: "x'; DROP" } };
    expect(() => roleAuditSql(bad)).toThrow("is not a complete install name map");
  });
});

describe("roleAuditError", () => {
  it("lists every violation", () => {
    expect(roleAuditError({ violations: ["a", "b"], warnings: [] })).toBe(
      [
        "Database role isolation check failed (issues #633, #635, #1689; CLAUDE.md §2):",
        "  - a",
        "  - b",
        ROLE_AUDIT_NEXT_STEP,
      ].join("\n"),
    );
  });
});

describe("evaluateRlsDrift & assertNoRlsPolicyDrift", () => {
  it("checks both public and plugin_% schemas for relrowsecurity, relforcerowsecurity, and pg_policies", () => {
    expect(RLS_DRIFT_SQL).toContain("n.nspname LIKE 'plugin_%'");
    expect(RLS_DRIFT_SQL).toContain("NOT c.relrowsecurity");
    expect(RLS_DRIFT_SQL).toContain("NOT c.relforcerowsecurity");
  });

  it("ignores __drizzle_migrations in public and flags tables missing ENABLE, FORCE, or CREATE POLICY", () => {
    expect(
      evaluateRlsDrift([
        {
          schema_name: "public",
          table_name: "__drizzle_migrations",
          rls_enabled: true,
          rls_forced: false,
          has_policy: false,
        },
        {
          schema_name: "public",
          table_name: "pages",
          rls_enabled: true,
          rls_forced: false,
          has_policy: true,
        },
        {
          schema_name: "plugin_forms",
          table_name: "submissions",
          rls_enabled: false,
          rls_forced: false,
          has_policy: false,
        },
      ]),
    ).toEqual([
      "pages (missing FORCE ROW LEVEL SECURITY)",
      "plugin_forms.submissions (missing ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, CREATE POLICY)",
    ]);
  });

  it("throws when evaluateRlsDrift finds any non-meta drift", async () => {
    await expect(
      assertNoRlsPolicyDrift({
        unsafe: async () => [
          {
            schema_name: "public",
            table_name: "users",
            rls_enabled: true,
            rls_forced: false,
            has_policy: true,
          },
        ],
      }),
    ).rejects.toThrow("users (missing FORCE ROW LEVEL SECURITY)");
  });
});
