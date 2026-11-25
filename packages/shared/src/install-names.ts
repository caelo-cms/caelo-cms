// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1689 — the names of one install's Postgres roles and databases.
 *
 * Postgres role names are server-wide, and an install names six roles and
 * three databases. Until #1689 those were fixed values (`admin_role`,
 * `cms_admin`, …), so every install needed a Postgres server of its own.
 * The name map lets several installs share one server: each install's
 * processes read the same map ({@link INSTALL_NAMES_ENV}), and everything
 * that checks or writes a role or database name takes it from there — the
 * migration runner (which renames the tokens of the committed migration
 * files, so the files stay as they are), the role audit, the Query API
 * adapter's identity check, the gateway's boot guard, plugin schema DDL
 * and the template copy. Isolation between installs is the database's
 * (CONNECT only for the install's own roles, no grant to another install's
 * role), proven by the role audit; docs/dev/shared-postgres.md.
 *
 * Logical database names (`database: "cms_admin"` in an op definition)
 * only choose a pool and never reach Postgres; they stay as they are. The
 * physical name of each pool's database is in the URL, and the adapter
 * checks it against this map.
 *
 * The default map is today's names: an install whose environment sets no
 * map behaves exactly as before. A map that is set is validated in full
 * (every name, all different) and never mixed with the defaults.
 *
 * Pure module — no I/O beyond reading the env object it is handed.
 */

import { z } from "zod";
import { POSTGRES_KEYWORDS_NEEDING_QUOTES } from "./postgres-keywords.js";

/** The env var that carries an install's name map, as JSON ({@link InstallNames}). */
export const INSTALL_NAMES_ENV = "CAELO_INSTALL_NAMES";

/** Postgres' identifier limit (NAMEDATALEN - 1): a longer name is cut without an error. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * Prefixes no install name may start with: `pg_` is reserved for
 * Postgres' own roles, the others name the managed services' own roles
 * and databases (Cloud SQL, RDS, Azure), which the role audit treats as
 * the service's, never an install's (migrations role-audit.ts).
 */
const RESERVED_PREFIXES = ["pg_", "cloudsql", "rds_", "rdsadmin", "azure_"] as const;

/**
 * A role or database name: a plain lower-case identifier that is no
 * Postgres keyword, so it never needs quoting and every SQL builder can
 * splice it as a whole word.
 */
const postgresName = z
  .string()
  .max(MAX_IDENTIFIER_BYTES, `must be at most ${MAX_IDENTIFIER_BYTES} characters`)
  .regex(/^[a-z_][a-z0-9_]*$/, "must be a lower-case identifier ([a-z_][a-z0-9_]*)")
  .refine(
    (name) => !POSTGRES_KEYWORDS_NEEDING_QUOTES.has(name),
    "must not be a Postgres keyword (it would need quoting in CREATE ROLE, GRANT and the migrations)",
  )
  .refine(
    (name) => !RESERVED_PREFIXES.some((p) => name.startsWith(p)),
    `must not start with ${RESERVED_PREFIXES.join(", ")} (reserved by Postgres and the managed services)`,
  );

/**
 * A role name: a {@link postgresName} that is not `public`, which Postgres
 * reserves for its PUBLIC pseudo-role and refuses in `CREATE ROLE` even
 * quoted (Codex review). `none` and `current_user`-style names are
 * keywords and already refused.
 */
const roleName = postgresName.refine(
  (name) => name !== "public",
  'must not be "public" (Postgres reserves it for the PUBLIC pseudo-role)',
);

/**
 * Databases every Postgres server has for itself: the maintenance and
 * template databases and the ones a managed service keeps (Cloud SQL, RDS,
 * Azure). They hold no install's data, and a managed service may restrict
 * them to, or open them for, the group a single install's admin role
 * belongs to, so the isolation checks never count them as another
 * install's (migrations role-audit.ts, the gateway's boot probe).
 */
export const SERVER_DATABASES: readonly string[] = Object.freeze([
  "postgres",
  "template0",
  "template1",
  "cloudsqladmin",
  "rdsadmin",
  "azure_maintenance",
  "azure_sys",
]);

/**
 * A database name: a {@link postgresName} that is none of the server's own
 * ({@link SERVER_DATABASES}). bootstrap.sh would close the maintenance
 * database to every other login and the migrations would run in it, and
 * the isolation checks never count those databases as an install's.
 */
const databaseName = postgresName.refine(
  (name) => !SERVER_DATABASES.includes(name),
  `must not be one of the server's own databases (${SERVER_DATABASES.join(", ")})`,
);

/** The roles of one install. */
export const RoleNamesSchema = z
  .object({
    /** The authoring + migration login (cms_admin, and the admin's pools on both public databases). */
    admin: roleName,
    /** The live gateway's only login, on the live public database. */
    public: roleName,
    /** The staging gateway's only login, on the staging public database (#1329). */
    publicStaging: roleName,
    /** NOLOGIN role of the operator-access sync job (cms_admin migration 0239). */
    operatorAccessReader: roleName,
    /** NOLOGIN role of the upgrader job and the self-hosted update agent (migration 0267). */
    platformUpdater: roleName,
    /**
     * The gateway's former cms_admin login (gone since #635). An install
     * that never had it still names it, so the migrations that strip what
     * an old one holds rename it like every other role, and never touch
     * another install's.
     */
    formerGateway: roleName,
  })
  .strict();

/** The physical databases of one install. */
export const DatabaseNamesSchema = z
  .object({
    /** The authoring database (logical `cms_admin`). */
    admin: databaseName,
    /** The live site's public database (logical `cms_public`). */
    public: databaseName,
    /** The staging site's public database (logical `cms_public_staging`, #1329). */
    publicStaging: databaseName,
  })
  .strict();

/** One install's role and database names. */
export const InstallNamesSchema = z
  .object({ roles: RoleNamesSchema, databases: DatabaseNamesSchema })
  .strict()
  .superRefine((names, ctx) => {
    for (const [kind, map] of [
      ["roles", names.roles],
      ["databases", names.databases],
    ] as const) {
      const seen = new Map<string, string>();
      for (const [slot, name] of Object.entries(map)) {
        const other = seen.get(name);
        if (other !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [kind, slot],
            message: `${kind}.${slot} and ${kind}.${other} are both "${name}" (every ${kind === "roles" ? "role" : "database"} of an install has a name of its own)`,
          });
        }
        seen.set(name, slot);
      }
    }
  });

/** The roles of one install. */
export type RoleNames = z.infer<typeof RoleNamesSchema>;
/** The physical databases of one install. */
export type DatabaseNames = z.infer<typeof DatabaseNamesSchema>;
/** One install's role and database names. */
export type InstallNames = z.infer<typeof InstallNamesSchema>;

/** The names every install had before #1689, and every install without a map keeps. */
export const DEFAULT_INSTALL_NAMES: InstallNames = Object.freeze({
  roles: Object.freeze({
    admin: "admin_role",
    public: "public_role",
    publicStaging: "public_staging_role",
    operatorAccessReader: "operator_access_reader",
    platformUpdater: "platform_updater",
    formerGateway: "gateway_role",
  }),
  databases: Object.freeze({
    admin: "cms_admin",
    public: "cms_public",
    publicStaging: "cms_public_staging",
  }),
});

/** The logical database names op definitions and pools use. */
export type LogicalDatabase = "cms_admin" | "cms_public" | "cms_public_staging";

/** Which slot of {@link DatabaseNames} each logical database is. */
const DATABASE_SLOT: Readonly<Record<LogicalDatabase, keyof DatabaseNames>> = {
  cms_admin: "admin",
  cms_public: "public",
  cms_public_staging: "publicStaging",
};

/**
 * The physical name of a logical database in this install.
 *
 * @example physicalDatabaseName(prefixedInstallNames("t1"), "cms_public") // → "t1_cms_public"
 */
export function physicalDatabaseName(names: InstallNames, logical: LogicalDatabase): string {
  return names.databases[DATABASE_SLOT[logical]];
}

/** Every role of the install, in map order. */
export function installRoles(names: InstallNames): string[] {
  return Object.values(names.roles);
}

/** Every physical database of the install: admin, live public, staging public. */
export function installDatabases(names: InstallNames): string[] {
  return [names.databases.admin, names.databases.public, names.databases.publicStaging];
}

/** Whether `names` are exactly today's names ({@link DEFAULT_INSTALL_NAMES}). */
export function isDefaultInstallNames(names: InstallNames): boolean {
  return JSON.stringify(canonical(names)) === JSON.stringify(canonical(DEFAULT_INSTALL_NAMES));
}

/** `names` with keys in schema order, so two equal maps serialise alike. */
function canonical(names: InstallNames): InstallNames {
  const r = names.roles;
  const d = names.databases;
  return {
    roles: {
      admin: r.admin,
      public: r.public,
      publicStaging: r.publicStaging,
      operatorAccessReader: r.operatorAccessReader,
      platformUpdater: r.platformUpdater,
      formerGateway: r.formerGateway,
    },
    databases: { admin: d.admin, public: d.public, publicStaging: d.publicStaging },
  };
}

/**
 * Parse a name map. `source` names where it came from in the error.
 *
 * @throws listing every problem when `raw` is not a complete, valid map
 */
export function parseInstallNames(raw: unknown, source: string): InstallNames {
  const parsed = InstallNamesSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map(
    (i) => `${i.path.length > 0 ? i.path.join(".") : "(map)"}: ${i.message}`,
  );
  throw new Error(
    `${source} is not a complete install name map (#1689):\n${problems.map((p) => `  - ${p}`).join("\n")}\nIt is JSON {"roles":{"admin","public","publicStaging","operatorAccessReader","platformUpdater","formerGateway"},"databases":{"admin","public","publicStaging"}}, every name set; leave ${INSTALL_NAMES_ENV} unset for the default names.`,
  );
}

/**
 * The install's name map from {@link INSTALL_NAMES_ENV}: the default names
 * when it is unset or empty (every install from before #1689), else the
 * parsed map.
 *
 * @throws when the variable is set but is not JSON or not a complete map —
 *   an install must never run half on its own names and half on another's
 */
export function installNamesFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InstallNames {
  const raw = env[INSTALL_NAMES_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_INSTALL_NAMES;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      `${INSTALL_NAMES_ENV} is not JSON (#1689); it holds the install's role and database names, e.g. the output of prefixedInstallNames("t1")`,
    );
  }
  return parseInstallNames(json, INSTALL_NAMES_ENV);
}

/** A prefix {@link prefixedInstallNames} accepts. */
const PREFIX = /^[a-z][a-z0-9_]{0,23}$/;

/**
 * The name map of an install whose every name is today's name behind
 * `<prefix>_` — the simplest map for a hosting provider that runs many
 * installs on one server, and the one the tests use.
 *
 * @example prefixedInstallNames("t1").roles.admin // → "t1_admin_role"
 * @throws when `prefix` is not a lower-case identifier of at most 24 characters
 */
export function prefixedInstallNames(prefix: string): InstallNames {
  if (!PREFIX.test(prefix)) {
    throw new Error(
      `install name prefix "${prefix}" must match ${PREFIX.source} (#1689): the longest name it fronts must stay within Postgres' 63-character limit`,
    );
  }
  const r = DEFAULT_INSTALL_NAMES.roles;
  const d = DEFAULT_INSTALL_NAMES.databases;
  const p = (name: string) => `${prefix}_${name}`;
  return parseInstallNames(
    {
      roles: {
        admin: p(r.admin),
        public: p(r.public),
        publicStaging: p(r.publicStaging),
        operatorAccessReader: p(r.operatorAccessReader),
        platformUpdater: p(r.platformUpdater),
        formerGateway: p(r.formerGateway),
      },
      databases: { admin: p(d.admin), public: p(d.public), publicStaging: p(d.publicStaging) },
    },
    `prefixedInstallNames("${prefix}")`,
  );
}

/**
 * The env a process of this install needs to know its names: nothing for
 * the default names (so an existing install's configuration stays byte for
 * byte what it was), {@link INSTALL_NAMES_ENV} otherwise.
 */
export function installNamesEnv(names: InstallNames): Record<string, string> {
  if (isDefaultInstallNames(names)) return {};
  return { [INSTALL_NAMES_ENV]: JSON.stringify(canonical(names)) };
}
