// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyPreMigrationRoles,
  convergeSelfHostedRoles,
  decideUp,
  PUBLIC_ROLE_LIMITS,
  preMigrationRolesScript,
  roleConvergenceScript,
  selfHostedBootstrapScript,
} from "./self-hosted-roles.js";

const PASSWORDS = { admin: "a'pw", public: "p-pw", publicStaging: "s'pw" };

describe("roleConvergenceScript (#613 review)", () => {
  const script = roleConvergenceScript(PASSWORDS);

  it("creates missing roles and (re)sets every role's password, quoted", () => {
    for (const role of ["admin_role", "public_role"]) {
      expect(script).toContain(
        `WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}')`,
      );
    }
    expect(script).toContain("ALTER ROLE admin_role WITH LOGIN PASSWORD 'a''pw';");
    expect(script).not.toContain("CREATE ROLE gateway_role");
  });

  it("drops the former gateway_role with what it holds in every database, and stops on the first error (#635, #1329)", () => {
    expect(script.startsWith("\\set ON_ERROR_STOP on")).toBe(true);
    const publicDrop = script.indexOf("\\connect cms_public");
    const adminDrop = script.indexOf("\\connect cms_admin");
    expect(publicDrop).toBeGreaterThan(-1);
    expect(adminDrop).toBeGreaterThan(publicDrop);
    expect(script.match(/DROP OWNED BY gateway_role/g)).toHaveLength(3);
    expect(script.indexOf("THEN DROP ROLE gateway_role;")).toBeGreaterThan(adminDrop);
    expect(script).not.toContain("caelo_grant_gateway_role");
  });
});

describe("the host agent's login (#696 Phase 4c)", () => {
  it("is created only with a password, inherits platform_updater and nothing else", () => {
    expect(roleConvergenceScript(PASSWORDS)).not.toContain("caelo_agent");
    const script = roleConvergenceScript(PASSWORDS, "ag'pw");
    expect(script).toContain(
      "ALTER ROLE caelo_agent WITH INHERIT LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'ag''pw';",
    );
    expect(script).toContain("'GRANT platform_updater TO caelo_agent' WHERE NOT pg_has_role(");
    // platform_updater exists before the grant, and its table grants are
    // re-applied in cms_admin (migrations 0267 + 0270).
    expect(script.indexOf("CREATE ROLE platform_updater NOLOGIN")).toBeLessThan(
      script.indexOf("GRANT platform_updater TO caelo_agent"),
    );
    expect(script.indexOf("\\connect cms_admin")).toBeLessThan(
      script.indexOf("PERFORM caelo_grant_platform_updater()"),
    );
  });
});

describe("selfHostedBootstrapScript — what Postgres runs on its first start", () => {
  it("holds no secret: every password comes from the container's environment", () => {
    const script = selfHostedBootstrapScript({ agent: true });
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain('-v caelo_agent_pw="$AGENT_ROLE_PASSWORD"');
    expect(script).toContain("ALTER ROLE admin_role WITH LOGIN PASSWORD :'admin_role_pw';");
    expect(script).toContain(`: "\${AGENT_ROLE_PASSWORD:?must be set in environment}"`);
    // The SQL heredoc is quoted, so the shell expands nothing inside it.
    expect(script).toContain("<<'CAELO_SQL'");
    expect(script.trimEnd().endsWith("CAELO_SQL")).toBe(true);
  });

  it("leaves the agent out when the install has none", () => {
    const script = selfHostedBootstrapScript({ agent: false });
    expect(script).not.toContain("AGENT_ROLE_PASSWORD");
    expect(script).not.toContain("caelo_agent");
    expect(script).toContain("CREATE ROLE platform_updater NOLOGIN");
  });
});

describe("convergeSelfHostedRoles", () => {
  it("does nothing while Postgres is down", async () => {
    let ran = false;
    const r = await convergeSelfHostedRoles(PASSWORDS, {
      probe: async () => false,
      psql: async () => {
        ran = true;
        return { exitCode: 0, stderr: "" };
      },
    });
    expect(r).toEqual({
      ok: false,
      reachable: false,
      error: "the Postgres container is not running",
    });
    expect(ran).toBe(false);
  });

  it("hands the script to psql on stdin and reports its failure", async () => {
    const scripts: string[] = [];
    const r = await convergeSelfHostedRoles(PASSWORDS, {
      probe: async () => true,
      psql: async (script) => {
        scripts.push(script);
        return { exitCode: 3, stderr: "ERROR: permission denied\n" };
      },
    });
    expect(scripts).toEqual([roleConvergenceScript(PASSWORDS)]);
    expect(r).toEqual({ ok: false, reachable: true, error: "ERROR: permission denied" });
  });
});

describe("decideUp — `cms-provision up` never switches URLs onto unapplied passwords", () => {
  it("a back-filled config converges, then proceeds and records it", () => {
    expect(decideUp(false, { ok: true })).toEqual({ kind: "proceed", markConverged: true });
  });

  it("a back-filled config with Postgres down aborts before writing anything", () => {
    const d = decideUp(false, { ok: false, reachable: false, error: "down" });
    expect(d.kind).toBe("abort");
    expect(d.kind === "abort" && d.error).toContain("up -d postgres");
  });

  it("a failed convergence aborts whatever the config says", () => {
    expect(decideUp(true, { ok: false, reachable: true, error: "boom" }).kind).toBe("abort");
  });

  it("an already converged config proceeds with a warning while Postgres is down", () => {
    const d = decideUp(true, { ok: false, reachable: false, error: "down" });
    expect(d).toMatchObject({ kind: "proceed", markConverged: false });
  });
});

describe("the staging database and its login (#1329)", () => {
  const staging = [
    "SELECT 'CREATE ROLE public_staging_role NOINHERIT LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_staging_role') \\gexec",
    "SELECT 'CREATE DATABASE cms_public_staging OWNER admin_role' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cms_public_staging') \\gexec",
    "REVOKE ALL ON DATABASE cms_public_staging FROM PUBLIC;",
    "GRANT CONNECT ON DATABASE cms_public_staging TO public_staging_role, admin_role;",
    "REVOKE ALL ON DATABASE cms_public_staging FROM public_role;",
    "REVOKE ALL ON DATABASE cms_public FROM public_staging_role;",
  ];

  it("are created on the first start, on every `up`, and before an upgrade's migrations", () => {
    for (const script of [roleConvergenceScript(PASSWORDS), preMigrationRolesScript("s'pw")]) {
      for (const st of staging) expect(script).toContain(st);
      expect(script).toContain("ALTER ROLE public_staging_role WITH LOGIN PASSWORD 's''pw';");
    }
    const bootstrap = selfHostedBootstrapScript({ agent: false });
    for (const st of staging) expect(bootstrap).toContain(st);
    expect(bootstrap).toContain(
      "ALTER ROLE public_staging_role WITH LOGIN PASSWORD :'public_staging_role_pw';",
    );
    expect(bootstrap).toContain('-v public_staging_role_pw="$PUBLIC_STAGING_ROLE_PASSWORD"');
  });

  it("drops the former gateway_role's leftovers in the staging database too", () => {
    expect(roleConvergenceScript(PASSWORDS)).toContain("\\connect cms_public_staging");
  });
});

describe("the gateway logins' limits (#1338, H3; #1329)", () => {
  const statements = ["public_role", "public_staging_role"].flatMap((role) => [
    `ALTER ROLE ${role} CONNECTION LIMIT ${PUBLIC_ROLE_LIMITS.connectionLimit};`,
    `ALTER ROLE ${role} SET statement_timeout = '${PUBLIC_ROLE_LIMITS.statementTimeout}';`,
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '${PUBLIC_ROLE_LIMITS.idleInTransactionSessionTimeout}';`,
    `ALTER ROLE ${role} SET work_mem = '${PUBLIC_ROLE_LIMITS.workMem}';`,
  ]);

  it("are set on the first start, on every `up`, and before an upgrade's migrations", () => {
    for (const script of [
      selfHostedBootstrapScript({ agent: false }),
      roleConvergenceScript(PASSWORDS),
      preMigrationRolesScript("s'pw"),
    ]) {
      for (const st of statements) expect(script).toContain(st);
    }
    // The pre-migration script drops no role and touches no other database:
    // only the staging database with its login, then the limits.
    const lines = preMigrationRolesScript("s'pw").split("\n").filter(Boolean);
    expect(lines[0]).toBe("\\set ON_ERROR_STOP on");
    expect(lines.slice(-statements.length)).toEqual(statements);
    expect(lines.some((l) => /DROP|\\connect/.test(l))).toBe(false);
  });

  it("match the values packages/migrations/src/bootstrap.sh sets (dev, CI, Cloud SQL bootstrap)", () => {
    const bootstrap = readFileSync(
      resolve(import.meta.dir, "../../migrations/src/bootstrap.sh"),
      "utf8",
    );
    for (const st of statements) expect(bootstrap).toContain(st);
  });

  it("refuse to run against a stopped database", async () => {
    let ran = false;
    const r = await applyPreMigrationRoles({
      stagingPassword: "s",
      probe: async () => false,
      psql: async () => {
        ran = true;
        return { exitCode: 0, stderr: "" };
      },
    });
    expect(r).toEqual({
      ok: false,
      reachable: false,
      error: "the Postgres container is not running",
    });
    expect(ran).toBe(false);
  });
});
