// SPDX-License-Identifier: MPL-2.0

/**
 * The API gateway's database identity (issues #613, #635; CLAUDE.md §2
 * "the public side has no path to cms_admin"): which env var it connects
 * with, which role that must resolve to, and the guard that refuses to boot
 * with any way into the authoring database. Kept apart from server.ts so
 * the dev launcher (dev.ts) can use it without loading the server.
 *
 * The gateway connects to cms_public ONLY, as public_role. What it needs
 * from authoring state the admin publishes into cms_public
 * (`@caelo-cms/migrations/public-projection`).
 */

import { databaseUrlFromEnv } from "@caelo-cms/shared";

/**
 * Env vars that would hand the gateway a cms_admin login — by NAME. The
 * value-based check in {@link adminDatabaseAccessInEnv} catches the same
 * thing under any other name; this list also catches a bare password,
 * which no value inspection can recognise.
 */
export const ADMIN_CREDENTIAL_ENV = [
  "ADMIN_DATABASE_URL",
  "ADMIN_DATABASE_PASSWORD",
  "PUBLIC_ADMIN_DATABASE_URL",
  "PUBLIC_ADMIN_DATABASE_PASSWORD",
  // #635 — the gateway's former gateway_role login on cms_admin.
  "GATEWAY_DATABASE_URL",
  "GATEWAY_DATABASE_PASSWORD",
  "GATEWAY_ROLE_PASSWORD",
  "ADMIN_ROLE_PASSWORD",
  "POSTGRES_PASSWORD",
] as const;

/** The only database the gateway may name, and the only role it may log in as. */
const PUBLIC_DATABASE = "cms_public";
const PUBLIC_ROLE = "public_role";

/** The env vars allowed to carry a database credential: the gateway's own login. */
const OWN_LOGIN_ENV = new Set(["PUBLIC_DATABASE_URL", "PUBLIC_DATABASE_PASSWORD"]);

/**
 * The roles the gateway's adapter must connect as: no cms_admin pool at
 * all, public_role on cms_public.
 */
export const GATEWAY_DATABASE_ROLES = {
  admin: null,
  public: [PUBLIC_ROLE],
} as const;

const POSTGRES_URL = /postgres(?:ql)?:\/\/[^\s"'`,;]{1,2048}/gi;

/** Why one Postgres URL is not the gateway's own login, or null when it is. */
function foreignDatabaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "an unparseable database URL";
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  const params = url.searchParams;
  const dbParam = params.get("dbname") ?? params.get("database");
  const userParam = params.get("user");
  if ((dbParam ?? database) !== PUBLIC_DATABASE) {
    return `a URL for database "${dbParam ?? (database || "<default>")}"`;
  }
  if ((userParam ?? user) !== PUBLIC_ROLE) {
    return `a URL that logs in as "${userParam ?? (user || "<default>")}"`;
  }
  return null;
}

/**
 * Every way into cms_admin the env offers, as `NAME: why` — never the value.
 * Checks names ({@link ADMIN_CREDENTIAL_ENV}, any other `*_DATABASE_PASSWORD`),
 * every Postgres URL inside any value (database must be cms_public, role
 * public_role) and the libpq variables (`PGDATABASE`, `PGUSER`, `PGSERVICE`,
 * `PGPASSWORD`, `PGPASSFILE`), which a Postgres client would pick up on its
 * own.
 */
export function adminDatabaseAccessInEnv(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    if ((ADMIN_CREDENTIAL_ENV as readonly string[]).includes(name)) {
      found.push(`${name}: a cms_admin credential by name`);
      continue;
    }
    if (/_DATABASE_PASSWORD$/.test(name) && !OWN_LOGIN_ENV.has(name)) {
      found.push(`${name}: a database password other than the gateway's own`);
      continue;
    }
    if (name === "PGDATABASE" && value !== PUBLIC_DATABASE) {
      found.push(`${name}: names database "${value}"`);
      continue;
    }
    if (name === "PGUSER" && value !== PUBLIC_ROLE) {
      found.push(`${name}: names role "${value}"`);
      continue;
    }
    if (name === "PGPASSWORD" || name === "PGSERVICE" || name === "PGPASSFILE") {
      found.push(`${name}: a libpq credential outside the gateway's own URL`);
      continue;
    }
    for (const match of value.matchAll(POSTGRES_URL)) {
      const why = foreignDatabaseUrl(match[0]);
      if (why) {
        found.push(`${name}: ${why}`);
        break;
      }
    }
  }
  return found;
}

/**
 * The gateway's connection URL: `PUBLIC_DATABASE_URL` (public_role on
 * cms_public) with its `_PASSWORD` companion applied.
 *
 * @throws naming every offending variable (never its value) when the env
 *   holds any way into cms_admin — an install whose env still carries one
 *   has not converged, and running anyway would hide that — or when the
 *   URL is missing.
 */
export function gatewayDatabaseUrls(env: Readonly<Record<string, string | undefined>>): {
  readonly public: string;
} {
  const leaked = adminDatabaseAccessInEnv(env);
  if (leaked.length > 0) {
    throw new Error(
      `the API gateway must not hold any cms_admin credential (CLAUDE.md §2: the public side has no path to cms_admin) but its environment does:\n${leaked.map((l) => `  - ${l}`).join("\n")}\nRemove them; the gateway connects to cms_public only, as public_role (PUBLIC_DATABASE_URL). Cloud installs: run \`cms-provision upgrade\`. Local dev with the shared root .env: start it with \`bun run --filter @caelo-cms/api-gateway dev\`, which leaves them out.`,
    );
  }
  const pub = databaseUrlFromEnv(["PUBLIC_DATABASE_URL"], env);
  if (!pub) {
    throw new Error("the API gateway needs PUBLIC_DATABASE_URL (public_role on cms_public)");
  }
  return { public: pub };
}

/** What the boot-time database check needs (a Bun SQL client fits). */
export interface IsolationQuery {
  unsafe(query: string): Promise<unknown>;
}

/**
 * Ask the database itself (#635): may the gateway's login reach cms_admin,
 * or does cms_public carry an extension that can (dblink, postgres_fdw, any
 * foreign server)? Run on the gateway's own connection at boot.
 *
 * @returns the reasons the login is not isolated; empty when it is.
 */
export async function databaseIsolationProblems(sql: IsolationQuery): Promise<string[]> {
  const [row] = (await sql.unsafe(`
    SELECT current_user::text AS who,
           current_database()::text AS db,
           has_database_privilege(current_user, 'cms_admin', 'CONNECT') AS admin_connect,
           (SELECT coalesce(array_agg(extname::text ORDER BY extname), ARRAY[]::text[])
              FROM pg_extension WHERE extname IN ('dblink', 'postgres_fdw')) AS bridges,
           (SELECT count(*)::int FROM pg_foreign_server) AS foreign_servers
  `)) as {
    who: string;
    db: string;
    admin_connect: boolean;
    bridges: string[];
    foreign_servers: number;
  }[];
  if (!row) return ["the isolation probe returned no row"];
  const problems: string[] = [];
  if (row.who !== PUBLIC_ROLE || row.db !== PUBLIC_DATABASE) {
    problems.push(`connected as ${row.who} on ${row.db}, not ${PUBLIC_ROLE} on ${PUBLIC_DATABASE}`);
  }
  if (row.admin_connect) problems.push(`${row.who} may CONNECT to cms_admin`);
  if (row.bridges.length > 0) {
    problems.push(
      `cms_public has ${row.bridges.join(", ")} installed, a bridge to other databases`,
    );
  }
  if (row.foreign_servers > 0) {
    problems.push(`cms_public defines ${row.foreign_servers} foreign server(s)`);
  }
  return problems;
}
