// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 guardrail (a): the gateway refuses to boot when its environment
 * offers database access beyond its own login — by variable name, by value
 * (cms_admin names, Postgres URLs, libpq keyword strings), and through
 * file-mounted secrets. The error names variables and files, never values.
 * Since #1329 the same holds crosswise between the two environments: the
 * live gateway refuses the staging database and login, and the reverse.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB_PUBLIC_POOL_MAX_ENV, GATEWAY_POOL_MAX } from "@caelo-cms/shared";
import {
  adminDatabaseAccessInEnv,
  type GatewayEnvironment,
  gatewayDatabaseUrls,
  gatewayEnvironmentFromEnv,
  nodeSecretFiles,
  type SecretFileReader,
} from "./database-env.js";

const OWN = {
  PUBLIC_DATABASE_URL: "postgres://public_role:p@db:5432/cms_public?sslmode=verify-full",
};

/** A filesystem with exactly `files` (path → contents). */
function fakeFiles(files: Record<string, string> = {}): SecretFileReader {
  return {
    list: (dir) => Object.keys(files).filter((p) => p.slice(0, p.lastIndexOf("/")) === dir),
    read: (path) => files[path] ?? null,
  };
}
const NO_FILES = fakeFiles();

function check(
  env: Record<string, string | undefined>,
  files = NO_FILES,
  environment: GatewayEnvironment = "live",
): string[] {
  return adminDatabaseAccessInEnv(env, environment, files);
}

const STAGING_OWN = {
  PUBLIC_DATABASE_URL:
    "postgres://public_staging_role:p@db:5432/cms_public_staging?sslmode=verify-full",
};

describe("adminDatabaseAccessInEnv (#635)", () => {
  it("accepts the own pool size every adapter sets, as a plain count only", () => {
    expect(check({ ...OWN, CAELO_DB_PUBLIC_POOL_MAX: "2" })).toEqual([]);
    expect(check({ ...STAGING_OWN, CAELO_DB_PUBLIC_POOL_MAX: "2" }, NO_FILES, "staging")).toEqual(
      [],
    );
    for (const value of ["postgres://admin_role:p@db/cms_admin", "2 host=db", "0", "-1"]) {
      expect(check({ ...OWN, CAELO_DB_PUBLIC_POOL_MAX: value })).toHaveLength(1);
    }
    expect(check({ ...OWN, CAELO_DB_POOL_MAX: "2" })).toHaveLength(1);
  });

  it("boots on the pool env every stack sets on a gateway (fresh plain-gcp install, 2026-11-04)", () => {
    // What poolBudgetEnv(…, "gateway") and the staging gateway setup set.
    const env = { [DB_PUBLIC_POOL_MAX_ENV]: String(GATEWAY_POOL_MAX) };
    expect(check({ ...OWN, ...env })).toEqual([]);
    expect(check({ ...STAGING_OWN, ...env }, NO_FILES, "staging")).toEqual([]);
  });

  it("accepts the gateway's own login and the env the adapters and platforms set", () => {
    expect(
      check({
        ...OWN,
        PUBLIC_DATABASE_PASSWORD: "p",
        CAELO_STAGING_GATE_SECRET: "s",
        CAELO_PROVIDER: "gcp",
        CAELO_ENV: "production",
        MEDIA_STORAGE_URL: "gs://acme-production-media",
        CAELO_STAGING_HOST: "staging.example.com",
        CAELO_SITE_URL: "https://example.com/?user=x&host=y",
        GATEWAY_PORT: "8090",
        PORT: "8080",
        NODE_ENV: "production",
        K_SERVICE: "caelo-gateway",
        ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/x",
        PATH: "/usr/bin",
        HOME: "/root",
        // Cloud Run sets the working directory in every container (v0.10.51
        // gateway crash-looped on it).
        PWD: "/app",
        OLDPWD: "/",
        PAGE_SIZE: "50",
        BYPASS_CACHE: "1",
      }),
    ).toEqual([]);
  });

  it("refuses every database-ish variable but its own login, whatever it holds", () => {
    for (const name of [
      "ADMIN_DATABASE_URL",
      "ADMIN_DATABASE_PASSWORD",
      "PUBLIC_ADMIN_DATABASE_URL",
      "GATEWAY_DATABASE_URL",
      "GATEWAY_ROLE_PASSWORD",
      "POSTGRES_PASSWORD",
      "DATABASE_URL",
      "FOO_DATABASE_PASSWORD",
      // Review finding: a password under an arbitrary name.
      "DB_ADMIN_PASS",
      "ADMIN_PWD",
      "MY_DSN",
      "PGHOST",
      "PGDATABASE",
      "PGUSER",
      "PGPASSWORD",
      "PGSERVICE",
      "PGPASSFILE",
      "DATABASE_URL_FILE",
    ]) {
      expect(check({ ...OWN, [name]: "x" })).toEqual([expect.stringContaining(`${name}:`)]);
    }
  });

  it("still checks the values of runtime variables like PWD", () => {
    expect(check({ ...OWN, PWD: "postgres://admin_role:x@db/cms_admin" })).toHaveLength(1);
  });

  it("refuses a Postgres URL under any other name, whatever it points at", () => {
    for (const url of [
      "postgres://public_role:p@db:5432/cms_admin",
      "postgresql://gateway_role@db/cms_admin?sslmode=require",
      "x=1 postgres://u@h/somewhere y=2",
      // Even a second public_role URL: one way to the database, not two.
      "postgres://public_role:p@db:5432/cms_public",
    ]) {
      expect(check({ ...OWN, SOME_OTHER_URL: url })).toEqual([
        expect.stringContaining("SOME_OTHER_URL: holds a database URL"),
      ]);
    }
  });

  it("refuses a libpq keyword connection string (review finding)", () => {
    for (const dsn of [
      "host=10.0.0.3 dbname=cms_public user=public_role password=x",
      "host=db port=5432 password=hunter2",
      "service=prod;user=someone",
    ]) {
      expect(check({ ...OWN, LEGACY_CONN: dsn })).toEqual([
        expect.stringContaining("LEGACY_CONN:"),
      ]);
    }
  });

  it("refuses any value naming cms_admin or one of its roles", () => {
    for (const value of ["cms_admin", "connect as ADMIN_ROLE", "gateway_role:secret"]) {
      expect(check({ ...OWN, NOTE: value })).toEqual([
        expect.stringContaining("NOTE: names cms_admin or one of its roles"),
      ]);
    }
  });

  it("refuses an own URL that is not public_role on cms_public", () => {
    for (const url of [
      "postgres://admin_role:a@db/cms_public",
      "postgres://public_role@db/cms_admin",
      "postgres://anyone@db/cms_public?dbname=cms_admin",
      "postgres://public_role@db/cms_public?service=admin",
      "postgres://public_role@db/cms_public?options=-c%20role%3Dadmin_role",
      "host=db dbname=cms_public user=public_role",
      "mysql://public_role@db/cms_public",
    ]) {
      expect(check({ PUBLIC_DATABASE_URL: url })).toEqual([
        expect.stringContaining("PUBLIC_DATABASE_URL:"),
      ]);
    }
  });

  it("reads the file a *_FILE variable names (review finding: file-mounted secrets)", () => {
    const files = fakeFiles({
      "/secrets/legacy": "postgres://admin_role:x@db/cms_admin",
      "/secrets/fine": "a-random-token",
    });
    expect(check({ ...OWN, LEGACY_SECRET_FILE: "/secrets/legacy" }, files)).toEqual([
      expect.stringContaining("LEGACY_SECRET_FILE: its file holds a database URL"),
    ]);
    expect(check({ ...OWN, TOKEN_FILE: "/secrets/fine" }, files)).toEqual([]);
    expect(check({ ...OWN, TOKEN_FILE: "/missing" }, files)).toEqual([]);
  });

  it("scans the secret mount directories", () => {
    const files = fakeFiles({
      "/run/secrets/admin_db_password": "hunter2",
      "/run/secrets/upstream": "host=db dbname=cms_public user=public_role",
      "/var/run/secrets/token": "eyJhbGciOi",
      "/var/run/secrets/creds": "gateway_role",
    });
    const found = check(OWN, files);
    expect(found).toEqual([
      expect.stringContaining("/run/secrets/admin_db_password: a database-related secret file"),
      expect.stringContaining("/run/secrets/upstream: a secret file that holds a libpq"),
      expect.stringContaining("/var/run/secrets/creds: a secret file that names cms_admin"),
    ]);
  });
});

describe("the two environments, crosswise (#1329)", () => {
  it("accepts the staging gateway's own login", () => {
    expect(check({ ...STAGING_OWN, PUBLIC_DATABASE_PASSWORD: "p" }, NO_FILES, "staging")).toEqual(
      [],
    );
  });

  it("the live gateway refuses the staging database and login, by URL and by name", () => {
    expect(check(STAGING_OWN)).toEqual([
      expect.stringContaining('PUBLIC_DATABASE_URL: a URL for database "cms_public_staging"'),
    ]);
    for (const value of ["cms_public_staging", "login as public_staging_role"]) {
      expect(check({ ...OWN, NOTE: value })).toEqual([
        expect.stringContaining("NOTE: names the staging environment's database or login"),
      ]);
    }
    expect(check({ ...OWN, X_FILE: "/s/x" }, fakeFiles({ "/s/x": "public_staging_role" }))).toEqual(
      [expect.stringContaining("X_FILE: its file names the staging environment's")],
    );
  });

  it("the staging gateway refuses the live database and login, by URL and by name", () => {
    expect(check(OWN, NO_FILES, "staging")).toEqual([
      expect.stringContaining('PUBLIC_DATABASE_URL: a URL for database "cms_public"'),
    ]);
    expect(
      check(
        { PUBLIC_DATABASE_URL: "postgres://public_role@db/cms_public_staging" },
        NO_FILES,
        "staging",
      ),
    ).toEqual([expect.stringContaining('a URL that logs in as "public_role"')]);
    for (const value of ["cms_public", "use public_role"]) {
      expect(check({ ...STAGING_OWN, NOTE: value }, NO_FILES, "staging")).toEqual([
        expect.stringContaining("NOTE: names the live environment's database or login"),
      ]);
    }
    // The staging names do not count as the live ones.
    expect(check({ ...STAGING_OWN, NOTE: "cms_public_staging" }, NO_FILES, "staging")).toEqual([]);
  });

  it("needs the environment named, and nothing else", () => {
    expect(gatewayEnvironmentFromEnv({ CAELO_GATEWAY_ENVIRONMENT: "staging" })).toBe("staging");
    for (const value of [undefined, "", "production", "LIVE"]) {
      expect(() => gatewayEnvironmentFromEnv({ CAELO_GATEWAY_ENVIRONMENT: value })).toThrow(
        "CAELO_GATEWAY_ENVIRONMENT=live or =staging",
      );
    }
    expect(() => gatewayDatabaseUrls(OWN, NO_FILES)).toThrow("CAELO_GATEWAY_ENVIRONMENT");
  });
});

describe("nodeSecretFiles (#635)", () => {
  it("reads small regular files and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "caelo-secrets-"));
    try {
      writeFileSync(join(dir, "token"), "postgres://admin_role@db/cms_admin");
      writeFileSync(join(dir, "huge"), "x".repeat(64 * 1024 + 1));
      mkdirSync(join(dir, "sub"));
      expect(nodeSecretFiles.list(dir).sort()).toEqual(
        ["huge", "sub", "token"].map((n) => join(dir, n)),
      );
      expect(nodeSecretFiles.read(join(dir, "token"))).toBe("postgres://admin_role@db/cms_admin");
      expect(nodeSecretFiles.read(join(dir, "huge"))).toBeNull();
      expect(nodeSecretFiles.read(join(dir, "sub"))).toBeNull();
      expect(nodeSecretFiles.read(join(dir, "missing"))).toBeNull();
      expect(nodeSecretFiles.list(join(dir, "missing"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gatewayDatabaseUrls (#635)", () => {
  it("names the offending variables and files, never their values", () => {
    let message = "";
    try {
      gatewayDatabaseUrls(
        {
          ...OWN,
          CAELO_GATEWAY_ENVIRONMENT: "live",
          LEGACY: "postgres://gateway_role:hunter2@10.0.0.3/cms_admin",
          DB_ADMIN_PASS: "sw0rdfish",
        },
        fakeFiles({ "/run/secrets/x": "host=10.0.0.4 user=admin_role password=pw9" }),
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("must not hold any cms_admin credential");
    expect(message).toContain("LEGACY");
    expect(message).toContain("DB_ADMIN_PASS");
    expect(message).toContain("/run/secrets/x");
    for (const secret of ["hunter2", "10.0.0.3", "sw0rdfish", "10.0.0.4", "pw9"]) {
      expect(message).not.toContain(secret);
    }
  });

  it("returns the environment and its public URL", () => {
    expect(gatewayDatabaseUrls({ ...OWN, CAELO_GATEWAY_ENVIRONMENT: "live" }, NO_FILES)).toEqual({
      environment: "live",
      public: OWN.PUBLIC_DATABASE_URL,
    });
    expect(
      gatewayDatabaseUrls({ ...STAGING_OWN, CAELO_GATEWAY_ENVIRONMENT: "staging" }, NO_FILES),
    ).toEqual({ environment: "staging", public: STAGING_OWN.PUBLIC_DATABASE_URL });
  });
});
