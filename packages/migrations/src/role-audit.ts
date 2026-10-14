// SPDX-License-Identifier: MPL-2.0

/**
 * The application-role isolation audit (issue #633, CLAUDE.md §2: "admin_role
 * and public_role are isolated").
 *
 * On Cloud SQL every user the Admin API creates — `public_role` among them —
 * joins `cloudsqlsuperuser` and gets CREATEROLE + CREATEDB. That handed the
 * visitor-facing login (the API gateway's cms_public connection) the
 * privileges of the group that owns both databases. `cms-provision` now
 * revokes those memberships through the Admin API (the identity that granted
 * them) and migration 0278 drops what SQL may drop; this audit is the guard
 * that proves the result. migrate.ts runs it after every cms_admin migration
 * run — install, `upgrade`, the in-cloud upgrader, self-hosted — and refuses
 * (non-zero exit, before any traffic moves) while a violation remains, so an
 * install can never silently keep or regain the over-privilege.
 *
 * Which role may hold what:
 *
 *   - `admin_role` is the authoring + migration role. On Cloud SQL it needs
 *     `cloudsqlsuperuser`: the Admin API makes that group the owner of
 *     cms_admin / cms_public (and so of their `public` schemas), and the
 *     migrations create roles and extensions. It is not audited.
 *   - `public_role`, `gateway_role` (the two logins the public gateway
 *     holds): no role membership at all, no SUPERUSER / BYPASSRLS /
 *     REPLICATION, and `public_role` must not be able to connect to
 *     cms_admin.
 *   - `operator_access_reader`, `platform_updater` (NOLOGIN roles of the
 *     in-cloud jobs) and every login that is a member of them (the jobs'
 *     Cloud SQL IAM users, the self-hosted update agent): no membership in a
 *     privileged group ({@link PRIVILEGED_GROUPS}), no SUPERUSER / BYPASSRLS
 *     / REPLICATION.
 *
 * CREATEROLE / CREATEDB are reported as warnings, not violations: migration
 * 0278 drops them where the migration role may alter the role, but whether
 * Cloud SQL lets admin_role alter a role the Admin API created is not
 * something Caelo controls, and without a privileged group neither attribute
 * reaches existing data (PostgreSQL 16+ lets a CREATEROLE role manage only
 * the roles it created).
 */

/** Roles the public gateway logs in as. */
export const GATEWAY_LOGIN_ROLES = ["public_role", "gateway_role"] as const;

/** NOLOGIN roles whose members are the in-cloud jobs' logins. */
export const JOB_ROLES = ["operator_access_reader", "platform_updater"] as const;

/**
 * Groups that carry privileges far beyond any application grant: the
 * managed-Postgres "almost superuser" groups (Cloud SQL, RDS, Azure), the
 * authoring role itself, and the predefined roles that read, write or
 * execute outside the RLS model.
 */
export const PRIVILEGED_GROUPS: readonly string[] = [
  "cloudsqlsuperuser",
  "rds_superuser",
  "azure_pg_admin",
  "admin_role",
  "pg_read_all_data",
  "pg_write_all_data",
  "pg_read_server_files",
  "pg_write_server_files",
  "pg_execute_server_program",
  "pg_create_subscription",
];

/** One audited role, as {@link ROLE_AUDIT_SQL} returns it. */
export interface AuditedRole {
  readonly rolname: string;
  /** Why it is audited: a gateway login, a job role, or a member of a job role. */
  readonly kind: "gateway-login" | "job-role" | "job-member";
  readonly rolsuper: boolean;
  readonly rolcreaterole: boolean;
  readonly rolcreatedb: boolean;
  readonly rolbypassrls: boolean;
  readonly rolreplication: boolean;
  /** Every role it is a member of, directly or through other roles. */
  readonly memberOf: readonly string[];
  /** Whether it may connect to the database the audit runs in (cms_admin). */
  readonly canConnectHere: boolean;
}

/**
 * The audit query. Run while connected to cms_admin (the CONNECT check is
 * against the current database). Roles that do not exist are simply absent.
 * Members of the job roles exclude admin_role, which bootstrap.sh makes a
 * member so the integration tests can SET ROLE to them.
 */
export const ROLE_AUDIT_SQL = `
WITH RECURSIVE membership(member, roleid) AS (
  SELECT member, roleid FROM pg_auth_members
  UNION
  SELECT m.member, a.roleid FROM membership m JOIN pg_auth_members a ON a.member = m.roleid
),
audited(oid, kind) AS (
  SELECT r.oid, 'gateway-login' FROM pg_roles r
   WHERE r.rolname IN (${GATEWAY_LOGIN_ROLES.map((r) => `'${r}'`).join(", ")})
  UNION
  SELECT r.oid, 'job-role' FROM pg_roles r
   WHERE r.rolname IN (${JOB_ROLES.map((r) => `'${r}'`).join(", ")})
  UNION
  SELECT a.member, 'job-member' FROM pg_auth_members a
    JOIN pg_roles g ON g.oid = a.roleid
    JOIN pg_roles m ON m.oid = a.member
   WHERE g.rolname IN (${JOB_ROLES.map((r) => `'${r}'`).join(", ")})
     AND m.rolname <> 'admin_role'
     AND m.rolname NOT IN (${[...GATEWAY_LOGIN_ROLES, ...JOB_ROLES].map((r) => `'${r}'`).join(", ")})
)
SELECT r.rolname::text AS rolname,
       a.kind::text AS kind,
       r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication,
       COALESCE(
         (SELECT array_agg(DISTINCT g.rolname::text ORDER BY g.rolname::text)
            FROM membership m JOIN pg_roles g ON g.oid = m.roleid
           WHERE m.member = r.oid),
         ARRAY[]::text[]
       ) AS member_of,
       has_database_privilege(r.oid, current_database(), 'CONNECT') AS can_connect_here
  FROM audited a JOIN pg_roles r ON r.oid = a.oid
 ORDER BY r.rolname
`;

/** A raw row of {@link ROLE_AUDIT_SQL}. */
export interface RoleAuditRow {
  readonly rolname: string;
  readonly kind: string;
  readonly rolsuper: boolean;
  readonly rolcreaterole: boolean;
  readonly rolcreatedb: boolean;
  readonly rolbypassrls: boolean;
  readonly rolreplication: boolean;
  readonly member_of: readonly string[] | null;
  readonly can_connect_here: boolean;
}

/** Normalise a row; throws on a kind the query cannot produce. */
export function toAuditedRole(row: RoleAuditRow): AuditedRole {
  if (row.kind !== "gateway-login" && row.kind !== "job-role" && row.kind !== "job-member") {
    throw new Error(`role audit: unexpected kind '${row.kind}' for ${row.rolname}`);
  }
  return {
    rolname: row.rolname,
    kind: row.kind,
    rolsuper: row.rolsuper,
    rolcreaterole: row.rolcreaterole,
    rolcreatedb: row.rolcreatedb,
    rolbypassrls: row.rolbypassrls,
    rolreplication: row.rolreplication,
    memberOf: row.member_of ?? [],
    canConnectHere: row.can_connect_here,
  };
}

export interface RoleAuditResult {
  /** Isolation breaches: the run must fail. */
  readonly violations: readonly string[];
  /** Over-privilege that does not breach isolation on its own. */
  readonly warnings: readonly string[];
}

/** Judge the audited roles; see the file comment for the rules. */
export function evaluateRoleAudit(roles: readonly AuditedRole[]): RoleAuditResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  for (const role of roles) {
    const name = role.rolname;
    for (const [attr, has] of [
      ["SUPERUSER", role.rolsuper],
      ["BYPASSRLS", role.rolbypassrls],
      ["REPLICATION", role.rolreplication],
    ] as const) {
      if (has) violations.push(`${name} has the ${attr} attribute`);
    }
    if (role.kind === "gateway-login") {
      if (role.memberOf.length > 0) {
        violations.push(`${name} is a member of ${role.memberOf.join(", ")} (it must be of none)`);
      }
      if (name === "public_role" && role.canConnectHere) {
        violations.push("public_role can connect to cms_admin");
      }
    } else {
      const privileged = role.memberOf.filter((g) => PRIVILEGED_GROUPS.includes(g));
      if (privileged.length > 0) {
        violations.push(`${name} is a member of ${privileged.join(", ")}`);
      }
    }
    const attrs = [
      ...(role.rolcreaterole ? ["CREATEROLE"] : []),
      ...(role.rolcreatedb ? ["CREATEDB"] : []),
    ];
    if (attrs.length > 0) {
      warnings.push(
        `${name} has ${attrs.join(" + ")} (migration 0278 could not drop it with the migration role's rights)`,
      );
    }
  }
  return { violations, warnings };
}

/** What the operator does about a violation; part of the error message. */
export const ROLE_AUDIT_NEXT_STEP =
  "On GCP run `cms-provision upgrade` (it revokes the Cloud SQL Admin API's role memberships from public_role, then migrates again); on a self-hosted install run `cms-provision up`. Do not roll any service until this check passes.";

/**
 * Format a failed audit as one error message: every violation, then the
 * next step.
 */
export function roleAuditError(result: RoleAuditResult): string {
  return [
    `Database role isolation check failed (issue #633, CLAUDE.md §2):`,
    ...result.violations.map((v) => `  - ${v}`),
    ROLE_AUDIT_NEXT_STEP,
  ].join("\n");
}

/** The minimal query surface the audit needs (a Bun SQL client fits). */
export interface AuditQuery {
  unsafe(query: string): Promise<unknown>;
}

/**
 * Run the audit on a cms_admin connection. Throws with
 * {@link roleAuditError} on a violation; returns the result (warnings
 * included) otherwise.
 */
export async function assertRoleIsolation(sql: AuditQuery): Promise<RoleAuditResult> {
  const rows = (await sql.unsafe(ROLE_AUDIT_SQL)) as RoleAuditRow[];
  const result = evaluateRoleAudit(rows.map(toAuditedRole));
  if (result.violations.length > 0) throw new Error(roleAuditError(result));
  return result;
}
