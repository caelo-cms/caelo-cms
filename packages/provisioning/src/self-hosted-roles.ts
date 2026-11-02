// SPDX-License-Identifier: MPL-2.0

/**
 * Converge a self-hosted install's database roles onto `.caelo/config.json`
 * (issue #613, CLAUDE.md §11.C idempotent re-runs).
 *
 * bootstrap.sh creates the application roles, but only on the Postgres
 * container's FIRST start (docker-entrypoint-initdb.d). An install created
 * before the per-role passwords has a data volume whose roles have other
 * passwords, so emitting Compose URLs with the new passwords would lock the
 * admin and the gateway out on the next restart. `cms-provision up`
 * therefore runs {@link roleConvergenceScript} through the running container
 * as the Postgres superuser BEFORE it writes the new Compose file: it
 * creates missing roles and databases and sets each role's password to the
 * configured one. It also drops the former `gateway_role` (#635: the
 * gateway has no cms_admin login), with whatever it still holds, and
 * (#1329) creates the staging database `cms_public_staging` with the
 * staging gateway's login `public_staging_role` on an install from before
 * it. Every statement is idempotent.
 *
 * Passwords travel on psql's stdin, never on argv.
 */

import type { RolePasswords } from "./compose.js";

/** A SQL string literal. */
function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * #696 Phase 4c — the host update agent's database login. A member of
 * `platform_updater` (migration 0267), so it holds exactly the upgrader's
 * grants: read requests + policy, move a request through its run columns,
 * append events, write the heartbeat (0270) and its own audit rows.
 */
export const AGENT_DB_ROLE = "caelo_agent";

/** The application roles bootstrap.sh and the convergence create. */
const APP_ROLES = ["admin_role", "public_role", "public_staging_role"] as const;

/** #1329 — the gateway logins that carry {@link PUBLIC_ROLE_LIMITS}: the live and the staging one. */
const GATEWAY_LOGINS = ["public_role", "public_staging_role"] as const;
type AppRole = (typeof APP_ROLES)[number];

/**
 * #1338 (gateway hardening H3) — what bounds public_role, the gateway's
 * login, on the database: at most this many connections, no statement or
 * idle transaction that runs away, little sort memory per query. The same
 * values as packages/migrations/src/bootstrap.sh and the cms_admin
 * migration that sets them where admin_role may (Cloud SQL); the role audit
 * (packages/migrations role-audit.ts) refuses an install without them.
 * Self-hosted admin_role has no CREATEROLE, so the superuser applies them
 * here — on the volume's first start (bootstrap.sh), on every `up`, and
 * before the migrations of every upgrade ({@link preMigrationRolesScript}).
 * Since #1329 the staging gateway's public_staging_role carries the same.
 */
export const PUBLIC_ROLE_LIMITS = {
  connectionLimit: 30,
  statementTimeout: "5s",
  idleInTransactionSessionTimeout: "15s",
  workMem: "1MB",
} as const;

/** The statements that apply {@link PUBLIC_ROLE_LIMITS} to both gateway logins (idempotent). */
function publicRoleLimitsSql(): string[] {
  const l = PUBLIC_ROLE_LIMITS;
  return GATEWAY_LOGINS.flatMap((role) => [
    `ALTER ROLE ${role} CONNECTION LIMIT ${l.connectionLimit};`,
    `ALTER ROLE ${role} SET statement_timeout = '${l.statementTimeout}';`,
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '${l.idleInTransactionSessionTimeout}';`,
    `ALTER ROLE ${role} SET work_mem = '${l.workMem}';`,
  ]);
}

/** How a role's password appears in the SQL: a literal, or a psql variable. */
type PasswordSql = (role: AppRole | typeof AGENT_DB_ROLE) => string;

/**
 * #1329 — the staging database and its gateway login, with each gateway
 * login on its own database only (the same as bootstrap.sh and cms_admin
 * migration 0530). Idempotent: an install from before #1329 gets both, an
 * install that has them gets the password re-applied.
 */
function stagingDatabaseSql(password: PasswordSql): string[] {
  return [
    "SELECT 'CREATE ROLE public_staging_role NOINHERIT LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_staging_role') \\gexec",
    `ALTER ROLE public_staging_role WITH LOGIN PASSWORD ${password("public_staging_role")};`,
    "SELECT 'CREATE DATABASE cms_public_staging OWNER admin_role' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cms_public_staging') \\gexec",
    "REVOKE ALL ON DATABASE cms_public_staging FROM PUBLIC;",
    "GRANT CONNECT ON DATABASE cms_public_staging TO public_staging_role, admin_role;",
    "REVOKE ALL ON DATABASE cms_public_staging FROM public_role;",
    "REVOKE ALL ON DATABASE cms_public FROM public_staging_role;",
    "REVOKE ALL ON DATABASE cms_admin FROM public_staging_role;",
  ];
}

/**
 * The psql script (superuser) the self-hosted upgrade runs BEFORE the
 * migrations: the gateway logins' {@link PUBLIC_ROLE_LIMITS} (#1338) and
 * (#1329) the staging database with its login. The migrations' role audit
 * refuses either gateway login without its limits, and the
 * cms_public_staging run needs the database; the full convergence must
 * wait until after them (it drops roles a migration retired). Fails when
 * public_role does not exist — the install's roles were never created.
 */
export function preMigrationRolesScript(stagingPassword: string): string {
  return [
    "\\set ON_ERROR_STOP on",
    ...stagingDatabaseSql(() => literal(stagingPassword)),
    ...publicRoleLimitsSql(),
    "",
  ].join("\n");
}

/**
 * The convergence SQL (psql, as the superuser, connected to any database).
 * `password` renders each role's password; `agent` adds the agent's login.
 */
function convergenceSql(password: PasswordSql, agent: boolean): string {
  return [
    "\\set ON_ERROR_STOP on",
    ...APP_ROLES.flatMap((role) => [
      `SELECT 'CREATE ROLE ${role} NOINHERIT LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') \\gexec`,
      `ALTER ROLE ${role} WITH LOGIN PASSWORD ${password(role)};`,
    ]),
    ...stagingDatabaseSql(password),
    ...publicRoleLimitsSql(),
    // The upgrader's role (migration 0267 creates it only with CREATEROLE,
    // which the self-hosted admin_role lacks).
    "SELECT 'CREATE ROLE platform_updater NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_updater') \\gexec",
    ...(agent
      ? [
          // INHERIT: the agent acts with platform_updater's privileges
          // without SET ROLE, like the Cloud SQL IAM user of the GCP job.
          `SELECT 'CREATE ROLE ${AGENT_DB_ROLE} INHERIT LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AGENT_DB_ROLE}') \\gexec`,
          `ALTER ROLE ${AGENT_DB_ROLE} WITH INHERIT LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${password(AGENT_DB_ROLE)};`,
          `SELECT 'GRANT platform_updater TO ${AGENT_DB_ROLE}' WHERE NOT pg_has_role('${AGENT_DB_ROLE}', 'platform_updater', 'MEMBER') \\gexec`,
        ]
      : []),
    "SELECT 'CREATE DATABASE cms_admin OWNER admin_role' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cms_admin') \\gexec",
    "SELECT 'CREATE DATABASE cms_public OWNER admin_role' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cms_public') \\gexec",
    "REVOKE ALL ON DATABASE cms_admin FROM PUBLIC;",
    "REVOKE ALL ON DATABASE cms_public FROM PUBLIC;",
    "GRANT CONNECT ON DATABASE cms_admin TO admin_role;",
    "GRANT CONNECT ON DATABASE cms_public TO public_role, admin_role;",
    // #635 — the gateway's former cms_admin login goes, with whatever it
    // still holds in either database (the superuser may drop what
    // migration 0285 could only revoke).
    "\\connect cms_public",
    "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role') THEN DROP OWNED BY gateway_role; END IF; END $$;",
    "\\connect cms_public_staging",
    "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role') THEN DROP OWNED BY gateway_role; END IF; END $$;",
    "\\connect cms_admin",
    "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role') THEN DROP OWNED BY gateway_role; END IF; END $$;",
    "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role') THEN DROP ROLE gateway_role; END IF; END $$;",
    // Migrations 0267 + 0270 (#696): the upgrader role's grants, applied
    // now that the role exists.
    "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'caelo_grant_platform_updater') THEN PERFORM caelo_grant_platform_updater(); END IF; END $$;",
    "",
  ].join("\n");
}

/**
 * The psql script (run as the superuser, connected to any database) that
 * brings roles and databases to the configured state.
 * Mirrors bootstrap.sh, plus the password reset bootstrap.sh never does.
 * With `agentPassword`, also the host agent's login (#696 Phase 4c).
 */
export function roleConvergenceScript(passwords: RolePasswords, agentPassword?: string): string {
  const byRole: Record<AppRole, string> = {
    admin_role: passwords.admin,
    public_role: passwords.public,
    public_staging_role: passwords.publicStaging,
  };
  return convergenceSql(
    (role) => literal(role === AGENT_DB_ROLE ? (agentPassword ?? "") : byRole[role]),
    agentPassword !== undefined,
  );
}

/** The env var bootstrap.sh reads each role's password from (compose.ts sets them). */
const PASSWORD_ENV: Record<AppRole | typeof AGENT_DB_ROLE, string> = {
  admin_role: "ADMIN_ROLE_PASSWORD",
  public_role: "PUBLIC_ROLE_PASSWORD",
  public_staging_role: "PUBLIC_STAGING_ROLE_PASSWORD",
  [AGENT_DB_ROLE]: "AGENT_ROLE_PASSWORD",
};

/**
 * `.caelo/bootstrap.sh` — what the Postgres container runs on its first
 * start (docker-entrypoint-initdb.d): the same convergence SQL, with every
 * password read from the container's environment (psql variables), so the
 * file holds no secret and can be world-readable for the postgres user.
 *
 * @param opts.agent - whether the Compose file sets up the host agent
 */
export function selfHostedBootstrapScript(opts: { readonly agent: boolean }): string {
  const roles: readonly (AppRole | typeof AGENT_DB_ROLE)[] = [
    ...APP_ROLES,
    ...(opts.agent ? [AGENT_DB_ROLE as typeof AGENT_DB_ROLE] : []),
  ];
  const variables = roles.map((role) => `  -v ${role}_pw="$${PASSWORD_ENV[role]}" \\`).join("\n");
  const checks = roles
    .map((role) => `: "\${${PASSWORD_ENV[role]}:?must be set in environment}"`)
    .join("\n");
  return `#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# Generated by cms-provision — do not edit. Runs once, on the Postgres
# container's first start: creates the Caelo roles and databases. Every
# password comes from the container's environment (docker-compose.yml).
set -e
${checks}
psql --username "$POSTGRES_USER" --dbname postgres -q \\
${variables}
  -f - <<'CAELO_SQL'
${convergenceSql((role) => `:'${role}_pw'`, opts.agent)}CAELO_SQL
`;
}

/** Runs a psql script as the superuser; resolves to psql's exit code + stderr. */
export type SuperuserPsql = (script: string) => Promise<{ exitCode: number; stderr: string }>;

/**
 * Apply {@link preMigrationRolesScript} through the running Postgres
 * container. Unlike {@link convergeSelfHostedRoles} a stopped database is a
 * failure: the upgrade runs it right before migrations that need it.
 */
export async function applyPreMigrationRoles(deps: {
  readonly probe: () => Promise<boolean>;
  readonly psql: SuperuserPsql;
  /** #1329 — public_staging_role's password from `.caelo/config.json`. */
  readonly stagingPassword: string;
}): Promise<ConvergeOutcome> {
  if (!(await deps.probe())) {
    return { ok: false, reachable: false, error: "the Postgres container is not running" };
  }
  const r = await deps.psql(preMigrationRolesScript(deps.stagingPassword));
  if (r.exitCode === 0) return { ok: true };
  return { ok: false, reachable: true, error: r.stderr.trim() || `psql exited ${r.exitCode}` };
}

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
  deps: {
    readonly probe: () => Promise<boolean>;
    readonly psql: SuperuserPsql;
    /** The host agent's password, when the agent is set up (#696). */
    readonly agentPassword?: string;
  },
): Promise<ConvergeOutcome> {
  if (!(await deps.probe())) {
    return { ok: false, reachable: false, error: "the Postgres container is not running" };
  }
  const r = await deps.psql(roleConvergenceScript(passwords, deps.agentPassword));
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
