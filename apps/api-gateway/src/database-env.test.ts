// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 guardrail (a): the gateway refuses to boot with ANY way into
 * cms_admin in its environment — recognised by variable name, by the
 * database and role inside any Postgres URL, and by the libpq variables a
 * client would pick up on its own. The error names variables, never values.
 */

import { describe, expect, it } from "bun:test";
import { adminDatabaseAccessInEnv, gatewayDatabaseUrls } from "./database-env.js";

const OWN = { PUBLIC_DATABASE_URL: "postgres://public_role:p@db:5432/cms_public" };

describe("adminDatabaseAccessInEnv (#635)", () => {
  it("accepts the gateway's own login and unrelated variables", () => {
    expect(
      adminDatabaseAccessInEnv({
        ...OWN,
        PUBLIC_DATABASE_PASSWORD: "p",
        CAELO_STAGING_GATE_SECRET: "s",
        PORT: "8080",
      }),
    ).toEqual([]);
  });

  it("refuses every known credential name", () => {
    for (const name of [
      "ADMIN_DATABASE_URL",
      "ADMIN_DATABASE_PASSWORD",
      "PUBLIC_ADMIN_DATABASE_URL",
      "PUBLIC_ADMIN_DATABASE_PASSWORD",
      "GATEWAY_DATABASE_URL",
      "GATEWAY_DATABASE_PASSWORD",
      "POSTGRES_PASSWORD",
    ]) {
      expect(adminDatabaseAccessInEnv({ ...OWN, [name]: "x" }).join()).toContain(name);
    }
  });

  it("refuses a cms_admin URL under any name, whatever role it names", () => {
    for (const url of [
      "postgres://public_role:p@db:5432/cms_admin",
      "postgresql://gateway_role@db/cms_admin?sslmode=require",
      "postgres://anyone@db/cms_public?dbname=cms_admin",
      "x=1 postgres://u@h/cms_admin y=2",
    ]) {
      expect(adminDatabaseAccessInEnv({ ...OWN, SOME_OTHER_URL: url })).toEqual([
        expect.stringContaining("SOME_OTHER_URL"),
      ]);
    }
  });

  it("refuses a cms_public URL with another role (admin_role reaches both databases)", () => {
    expect(
      adminDatabaseAccessInEnv({ DATABASE_URL: "postgres://admin_role:a@db/cms_public" }),
    ).toEqual([expect.stringContaining('logs in as "admin_role"')]);
    expect(
      adminDatabaseAccessInEnv({ PUBLIC_DATABASE_URL: "postgres://admin_role:a@db/cms_public" }),
    ).toHaveLength(1);
  });

  it("refuses the libpq variables a client would use on its own", () => {
    expect(adminDatabaseAccessInEnv({ ...OWN, PGDATABASE: "cms_admin" })).toHaveLength(1);
    expect(adminDatabaseAccessInEnv({ ...OWN, PGUSER: "admin_role" })).toHaveLength(1);
    expect(adminDatabaseAccessInEnv({ ...OWN, PGPASSWORD: "x" })).toHaveLength(1);
    expect(adminDatabaseAccessInEnv({ ...OWN, PGSERVICE: "admin" })).toHaveLength(1);
  });

  it("refuses any other *_DATABASE_PASSWORD", () => {
    expect(adminDatabaseAccessInEnv({ ...OWN, FOO_DATABASE_PASSWORD: "x" })).toHaveLength(1);
  });
});

describe("gatewayDatabaseUrls (#635)", () => {
  it("names the offending variables and never their values", () => {
    let message = "";
    try {
      gatewayDatabaseUrls({ ...OWN, LEGACY: "postgres://gateway_role:hunter2@10.0.0.3/cms_admin" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("must not hold any cms_admin credential");
    expect(message).toContain("LEGACY");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("10.0.0.3");
  });

  it("returns only the public URL", () => {
    expect(gatewayDatabaseUrls(OWN)).toEqual({ public: OWN.PUBLIC_DATABASE_URL });
  });
});
