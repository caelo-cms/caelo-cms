// SPDX-License-Identifier: MPL-2.0

/**
 * #613 review — `cms-provision up` on a self-hosted volume created before
 * the per-role passwords: no `gateway_role`, `public_role` on another
 * password. The convergence script, run as the superuser exactly as `up`
 * runs it (psql, script on stdin), must leave the roles on the configured
 * passwords with the gateway's grants in place — and be safe to re-run.
 *
 * Runs against the test database with the passwords the environment already
 * uses, so the other suites' connection URLs keep working afterwards.
 */

import { describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { convergeSelfHostedRoles, type SuperuserPsql } from "./self-hosted-roles.js";

const env = process.env;
const required = [
  "POSTGRES_USER",
  "POSTGRES_PORT",
  "ADMIN_ROLE_PASSWORD",
  "PUBLIC_ROLE_PASSWORD",
  "GATEWAY_ROLE_PASSWORD",
  "ADMIN_DATABASE_URL",
  "GATEWAY_DATABASE_URL",
] as const;
const missing = required.filter((name) => !env[name]);
if (missing.length > 0) throw new Error(`${missing.join(", ")} required (see .env.example)`);

/** psql as the superuser — the local equivalent of `docker compose exec postgres psql`. */
const psql: SuperuserPsql = async (script) => {
  const proc = Bun.spawn(
    [
      "psql",
      "-h",
      env.PGHOST ?? "localhost",
      "-p",
      env.POSTGRES_PORT as string,
      "-U",
      env.POSTGRES_USER as string,
      "-d",
      "postgres",
      "-q",
      "-f",
      "-",
    ],
    {
      stdin: new TextEncoder().encode(script),
      stdout: "ignore",
      stderr: "pipe",
      env: { ...env, ...(env.POSTGRES_PASSWORD ? { PGPASSWORD: env.POSTGRES_PASSWORD } : {}) },
    },
  );
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr };
};

const passwords = {
  admin: env.ADMIN_ROLE_PASSWORD as string,
  public: env.PUBLIC_ROLE_PASSWORD as string,
  gateway: env.GATEWAY_ROLE_PASSWORD as string,
};

describe("self-hosted role convergence against Postgres (#613 review)", () => {
  it("brings a pre-#613 volume to the configured roles, grants and passwords — twice", async () => {
    // The pre-#613 volume: no gateway_role, public_role on another password.
    const reset = await psql(
      [
        "\\set ON_ERROR_STOP on",
        "\\connect cms_admin",
        "DROP OWNED BY gateway_role;",
        "\\connect postgres",
        "DROP ROLE gateway_role;",
        "ALTER ROLE public_role WITH PASSWORD 'the-old-shared-password';",
        "",
      ].join("\n"),
    );
    expect(reset).toEqual({ exitCode: 0, stderr: "" });

    for (let run = 0; run < 2; run++) {
      const r = await convergeSelfHostedRoles(passwords, { probe: async () => true, psql });
      expect(r).toEqual({ ok: true });
    }

    // The gateway logs in with its configured password and reads what 0248 grants.
    const gateway = new SQL(env.GATEWAY_DATABASE_URL as string);
    try {
      const rows = (await gateway.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return tx`SELECT current_user::text AS u, length(gateway_cookie_secret) > 0 AS s FROM site_settings`;
      })) as { u: string; s: boolean }[];
      expect(rows[0]).toEqual({ u: "gateway_role", s: true });
    } finally {
      await gateway.end();
    }
    const admin = new SQL(env.ADMIN_DATABASE_URL as string);
    try {
      const [attrs] = (await admin`
        SELECT rolcanlogin, rolinherit FROM pg_roles WHERE rolname = 'gateway_role'`) as {
        rolcanlogin: boolean;
        rolinherit: boolean;
      }[];
      expect(attrs).toEqual({ rolcanlogin: true, rolinherit: false });
      const policies = (await admin`
        SELECT policyname::text AS p FROM pg_policies WHERE 'gateway_role' = ANY (roles) ORDER BY 1`) as {
        p: string;
      }[];
      expect(policies.map((p) => p.p)).toEqual([
        "audit_events_gateway_plugin_only",
        "rate_limit_buckets_gateway_keys",
      ]);
    } finally {
      await admin.end();
    }
  });
});
