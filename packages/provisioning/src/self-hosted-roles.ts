// SPDX-License-Identifier: MPL-2.0

/**
 * Converge a self-hosted install's database roles onto `.caelo/config.json`
 * (issue #613, CLAUDE.md §11.C idempotent re-runs).
 *
 * bootstrap.sh creates the application roles, but only on the Postgres
 * container's FIRST start (docker-entrypoint-initdb.d). An install created
 * before the per-role passwords has a data volume whose roles have other
 * passwords — and no `gateway_role` at all — so emitting Compose URLs with
 * the new passwords would lock the admin and the gateway out on the next
 * restart. `cms-provision up` therefore runs {@link roleConvergenceScript}
 * through the running container as the Postgres superuser BEFORE it writes
 * the new Compose file: it creates missing roles and databases, sets each
 * role's password to the configured one, and re-applies migration 0248's
 * gateway grants. Every statement is idempotent.
 *
 * Passwords travel on psql's stdin, never on argv.
 */

import type { RolePasswords } from "./compose.js";

/** A SQL string literal. */
function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The psql script (run as the superuser, connected to any database) that
 * brings roles, databases and the gateway's grants to the configured state.
 * Mirrors bootstrap.sh, plus the password reset bootstrap.sh never does.
 */
export function roleConvergenceScript(passwords: RolePasswords): string {
  const roles: [string, string][] = [
    ["admin_role", passwords.admin],
    ["public_role", passwords.public],
    ["gateway_role", passwords.gateway],
  ];
  return [
    "\\set ON_ERROR_STOP on",
    ...roles.flatMap(([role, password]) => [
      `SELECT 'CREATE ROLE ${role} NOINHERIT LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') \\gexec`,
      `ALTER ROLE ${role} WITH LOGIN PASSWORD ${literal(password)};`,
    ]),
    "SELECT 'CREATE DATABASE cms_admin OWNER admin_role' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cms_admin') \\gexec",
    "SELECT 'CREATE DATABASE cms_public OWNER admin_role' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cms_public') \\gexec",
    "REVOKE ALL ON DATABASE cms_admin FROM PUBLIC;",
    "REVOKE ALL ON DATABASE cms_public FROM PUBLIC;",
    "GRANT CONNECT ON DATABASE cms_admin TO admin_role;",
    "GRANT CONNECT ON DATABASE cms_public TO public_role, admin_role;",
    "\\connect cms_admin",
    // A database that ran migration 0248 before gateway_role existed has no
    // grants for it yet; one that has not run it yet gets them from it.
    "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'caelo_grant_gateway_role') THEN PERFORM caelo_grant_gateway_role(); END IF; END $$;",
    "",
  ].join("\n");
}

/** Runs a psql script as the superuser; resolves to psql's exit code + stderr. */
export type SuperuserPsql = (script: string) => Promise<{ exitCode: number; stderr: string }>;

export type ConvergeOutcome =
  | { readonly ok: true }
  /** `reachable: false` — the database is not running, nothing was attempted. */
  | { readonly ok: false; readonly reachable: boolean; readonly error: string };

/**
 * Apply {@link roleConvergenceScript}. `probe` says whether the database is
 * up; when it is not, nothing is attempted and the caller decides whether
 * that is acceptable (it is not while the config's passwords were never
 * applied).
 */
export async function convergeSelfHostedRoles(
  passwords: RolePasswords,
  deps: { readonly probe: () => Promise<boolean>; readonly psql: SuperuserPsql },
): Promise<ConvergeOutcome> {
  if (!(await deps.probe())) {
    return { ok: false, reachable: false, error: "the Postgres container is not running" };
  }
  const r = await deps.psql(roleConvergenceScript(passwords));
  if (r.exitCode === 0) return { ok: true };
  return { ok: false, reachable: true, error: r.stderr.trim() || `psql exited ${r.exitCode}` };
}

/** What `cms-provision up` does with a convergence outcome. */
export type UpDecision =
  | { readonly kind: "proceed"; readonly markConverged: boolean; readonly warning?: string }
  | { readonly kind: "abort"; readonly error: string };

/**
 * Whether `up` may write Compose URLs with the configured passwords. Never
 * while they are not known to be applied: an install whose config just got
 * its role passwords (`rolesConverged: false`) must converge first.
 */
export function decideUp(rolesConverged: boolean, outcome: ConvergeOutcome): UpDecision {
  if (outcome.ok) return { kind: "proceed", markConverged: !rolesConverged };
  if (outcome.reachable) {
    return {
      kind: "abort",
      error: `could not bring the database roles in line with .caelo/config.json: ${outcome.error}. Nothing was changed; fix the cause and re-run \`cms-provision up\`.`,
    };
  }
  if (!rolesConverged) {
    return {
      kind: "abort",
      error:
        "the database roles must be updated before the services switch to their new passwords, but the Postgres container is not running. Start it (`docker compose -f .caelo/docker-compose.yml up -d postgres`) and re-run `cms-provision up`. Nothing was changed.",
    };
  }
  return {
    kind: "proceed",
    markConverged: false,
    warning: "the Postgres container is not running; the database roles were not re-checked",
  };
}
