// SPDX-License-Identifier: MPL-2.0

/**
 * The API gateway's database identity (issues #613, #635; CLAUDE.md §2
 * "the public side has no path to cms_admin"): which env var it connects
 * with, which role that must resolve to, and the guard that refuses to boot
 * when the env offers database access beyond that one login (exactly what
 * it checks, and what it cannot see, is listed at
 * {@link adminDatabaseAccessInEnv}). Kept apart from server.ts so
 * the dev launcher (dev.ts) can use it without loading the server.
 *
 * The gateway connects to cms_public ONLY, as public_role. What it needs
 * from authoring state the admin publishes into cms_public
 * (`@caelo-cms/migrations/public-projection`).
 */

import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { databaseUrlFromEnv } from "@caelo-cms/shared";

/** The only database the gateway may name, and the only role it may log in as. */
const PUBLIC_DATABASE = "cms_public";
const PUBLIC_ROLE = "public_role";

/**
 * The ONLY env vars that may carry anything database-related: the gateway's
 * own login. Every other database-ish variable is refused, whatever it holds
 * — the gateway has exactly one way to its database.
 */
export const GATEWAY_DATABASE_ENV = ["PUBLIC_DATABASE_URL", "PUBLIC_DATABASE_PASSWORD"] as const;
const OWN_LOGIN_ENV = new Set<string>(GATEWAY_DATABASE_ENV);

/**
 * The roles the gateway's adapter must connect as: no cms_admin pool at
 * all, public_role on cms_public.
 */
export const GATEWAY_DATABASE_ROLES = {
  admin: null,
  public: [PUBLIC_ROLE],
} as const;

/**
 * A database-ish variable or secret-file name: any `_`-separated token that
 * names a database, a Postgres client setting (libpq's `PG*`, which Bun SQL
 * and every other client read on their own), a connection string or a
 * password. Matched per token, so `BYPASS` or `PAGE_SIZE` do not count.
 */
const DATABASE_ISH_TOKEN =
  /^(?:DB|DBNAME|DBUSER|DATABASE|DATABASES|PG[A-Z]*|POSTGRES|POSTGRESQL|PSQL|SQL|DSN|PASS|PASSWD|PASSWORD|PASSWORDS|PWD|CREDENTIAL|CREDENTIALS)$/;

/**
 * Variables the OS, the shell or the container runtime set on their own,
 * whose names merely look database-ish: `PWD` is the working directory
 * (Cloud Run sets it in every container), not a password. Exempt from the
 * name check only; their values still get the value checks, so a Postgres
 * URL smuggled into `PWD` is still refused.
 */
const RUNTIME_ENV_NAMES = new Set(["PWD", "OLDPWD"]);

function isDatabaseIshName(name: string): boolean {
  return name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some((token) => DATABASE_ISH_TOKEN.test(token));
}

/** A value naming the authoring database or one of its roles, in any form. */
const ADMIN_NAME = /(?<![a-z0-9_])(?:cms_admin|admin_role|gateway_role)(?![a-z0-9_])/i;

const POSTGRES_URL = /postgres(?:ql)?:\/\/[^\s"'`,;]{1,2048}/gi;

/**
 * A libpq keyword/value connection string (`host=… dbname=… user=…`): at
 * least two connection keywords, which no ordinary setting carries.
 */
const DSN_KEYWORD = /(?:^|[\s;])(?:host|hostaddr|dbname|user|password|passfile|service|port)\s*=/gi;

function isKeywordDsn(value: string): boolean {
  return (value.match(DSN_KEYWORD) ?? []).length >= 2;
}

/** Why the gateway's own URL is not public_role on cms_public, or null when it is. */
function foreignOwnUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a postgres:// URL";
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return "not a postgres:// URL";
  }
  const params = url.searchParams;
  for (const p of ["service", "passfile", "options"]) {
    if (params.has(p)) return `a URL with a "${p}" parameter, which can switch database or role`;
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
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

/** Why a value outside the gateway's own login is a way to a database, or null. */
function databaseAccessInValue(value: string): string | null {
  if (value.search(POSTGRES_URL) !== -1) return "holds a database URL";
  if (isKeywordDsn(value)) return "holds a libpq keyword connection string";
  if (ADMIN_NAME.test(value)) return "names cms_admin or one of its roles";
  return null;
}

/**
 * Where file-mounted secrets live: Docker/Compose `secrets:` and the
 * Kubernetes convention. Only regular files directly inside are read.
 */
export const SECRET_MOUNT_DIRS = ["/run/secrets", "/var/run/secrets"] as const;

/** Largest secret file the guard reads; anything larger is not a credential. */
const MAX_SECRET_FILE_BYTES = 64 * 1024;

/** How the guard reads files (injected in tests). */
export interface SecretFileReader {
  /** Entries directly in `dir` (full paths); empty when it does not exist. */
  list(dir: string): string[];
  /** The file's text, or null when it is missing, unreadable, too large or not a file. */
  read(path: string): string | null;
}

/**
 * The real filesystem. A file is opened once and checked on that handle
 * (`fstat`), never checked by path and then read again by path, so what is
 * checked is what is read; `O_NONBLOCK` keeps a FIFO from blocking boot.
 */
export const nodeSecretFiles: SecretFileReader = {
  list(dir) {
    try {
      return readdirSync(dir).map((n) => join(dir, n));
    } catch {
      return [];
    }
  },
  read(path) {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch {
      return null;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_SECRET_FILE_BYTES) return null;
      const buf = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return n > MAX_SECRET_FILE_BYTES ? null : buf.subarray(0, n).toString("utf8");
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  },
};

/**
 * Every way to a database the gateway's environment offers besides its own
 * login, as `NAME: why` — never the value. What is checked, exactly:
 *
 * - **Names.** Only {@link GATEWAY_DATABASE_ENV} may be database-ish. Any
 *   other variable whose name has a database, `PG*`, connection-string or
 *   password token (`DATABASE_URL`, `PGPASSWORD`, `DB_ADMIN_PASS`, …) is
 *   refused, whatever it holds.
 * - **Values** of every other variable: one naming `cms_admin`,
 *   `admin_role` or `gateway_role`, holding a Postgres URL, or holding a
 *   libpq keyword connection string (`host=… dbname=… user=…`).
 * - **The own login.** `PUBLIC_DATABASE_URL` must be a postgres:// URL for
 *   public_role on cms_public, without `service`/`passfile`/`options`.
 * - **File-mounted secrets.** A `*_FILE` variable's file, and every regular
 *   file directly in {@link SECRET_MOUNT_DIRS}: a database-ish file name is
 *   refused, the contents get the value checks.
 *
 * Not detectable, and not claimed: a bare password stored under a name with
 * no database or password token, or a secret file mounted at an arbitrary
 * path that no `*_FILE` variable names. The database-side probe
 * ({@link databaseIsolationProblems}) and the role audit cover the role
 * itself; the provisioning tests cover what each adapter hands the gateway.
 */
export function adminDatabaseAccessInEnv(
  env: Readonly<Record<string, string | undefined>>,
  files: SecretFileReader = nodeSecretFiles,
): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    if (name === "PUBLIC_DATABASE_URL") {
      const why = foreignOwnUrl(value);
      if (why) found.push(`${name}: ${why}`);
      continue;
    }
    if (OWN_LOGIN_ENV.has(name)) continue;
    if (!RUNTIME_ENV_NAMES.has(name) && isDatabaseIshName(name)) {
      found.push(
        `${name}: a database-related variable; the gateway's only database access is PUBLIC_DATABASE_URL`,
      );
      continue;
    }
    const why = databaseAccessInValue(value);
    if (why) {
      found.push(`${name}: ${why}`);
      continue;
    }
    if (/_FILE$/i.test(name)) {
      const contents = files.read(value);
      const fileWhy = contents === null ? null : databaseAccessInValue(contents);
      if (fileWhy) found.push(`${name}: its file ${fileWhy}`);
    }
  }
  for (const dir of SECRET_MOUNT_DIRS) {
    for (const path of files.list(dir)) {
      const base = path.slice(path.lastIndexOf("/") + 1);
      if (isDatabaseIshName(base)) {
        found.push(`${path}: a database-related secret file`);
        continue;
      }
      const contents = files.read(path);
      const why = contents === null ? null : databaseAccessInValue(contents);
      if (why) found.push(`${path}: a secret file that ${why}`);
    }
  }
  return found;
}

/**
 * The gateway's connection URL: `PUBLIC_DATABASE_URL` (public_role on
 * cms_public) with its `_PASSWORD` companion applied.
 *
 * @throws naming every offending variable or file (never its value) when
 *   {@link adminDatabaseAccessInEnv} finds anything — an install whose env
 *   still carries such access has not converged, and running anyway would
 *   hide that — or when the URL is missing.
 */
export function gatewayDatabaseUrls(
  env: Readonly<Record<string, string | undefined>>,
  files: SecretFileReader = nodeSecretFiles,
): {
  readonly public: string;
} {
  const leaked = adminDatabaseAccessInEnv(env, files);
  if (leaked.length > 0) {
    throw new Error(
      `the API gateway must not hold any cms_admin credential (CLAUDE.md §2: the public side has no path to cms_admin), and its only database access is PUBLIC_DATABASE_URL, but its environment offers more:\n${leaked.map((l) => `  - ${l}`).join("\n")}\nRemove them; the gateway connects to cms_public only, as public_role (PUBLIC_DATABASE_URL). Cloud installs: run \`cms-provision upgrade\`. Local dev with the shared root .env: start it with \`bun run --filter @caelo-cms/api-gateway dev\`, which leaves them out.`,
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
