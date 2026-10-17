// SPDX-License-Identifier: MPL-2.0

/**
 * #613 review, #635 — `cms-provision up` on a self-hosted volume from
 * before: `public_role` on another password, and the gateway's former
 * `gateway_role` login still there with its grants. The convergence
 * script, run as the superuser exactly as `up` runs it (psql, script on
 * stdin), must leave the roles on the configured passwords and the former
 * gateway_role gone — and be safe to re-run.
 *
 * Runs against the test database with the passwords the environment already
 * uses, so the other suites' connection URLs keep working afterwards.
 */

import { describe, expect, it } from "bun:test";
import { SQL } from "bun";
import {
  convergeSelfHostedRoles,
  type SuperuserPsql,
  selfHostedBootstrapScript,
} from "./self-hosted-roles.js";

const env = process.env;
const required = [
  "POSTGRES_USER",
  "POSTGRES_PORT",
  "ADMIN_ROLE_PASSWORD",
  "PUBLIC_ROLE_PASSWORD",
  "ADMIN_DATABASE_URL",
  "PUBLIC_DATABASE_URL",
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
};

describe("self-hosted role convergence against Postgres (#613 review, #635)", () => {
  it("brings an old volume to the configured roles and passwords, without gateway_role — twice", async () => {
    // The old volume: the former gateway_role with a cms_admin grant, and
    // public_role on another password.
    const reset = await psql(
      [
        "\\set ON_ERROR_STOP on",
        "SELECT 'CREATE ROLE gateway_role NOINHERIT LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role') \\gexec",
        "GRANT CONNECT ON DATABASE cms_admin TO gateway_role;",
        "\\connect cms_admin",
        "GRANT SELECT (gateway_cookie_secret) ON site_settings TO gateway_role;",
        "\\connect postgres",
        "ALTER ROLE public_role WITH PASSWORD 'the-old-shared-password';",
        "",
      ].join("\n"),
    );
    expect(reset).toEqual({ exitCode: 0, stderr: "" });

    for (let run = 0; run < 2; run++) {
      const r = await convergeSelfHostedRoles(passwords, { probe: async () => true, psql });
      expect(r).toEqual({ ok: true });
    }

    // public_role logs in with its configured password again.
    const pub = new SQL(env.PUBLIC_DATABASE_URL as string);
    try {
      const [who] = (await pub`SELECT current_user::text AS u`) as { u: string }[];
      expect(who?.u).toBe("public_role");
    } finally {
      await pub.end();
    }
    // The former gateway_role is gone, with its grants (#635).
    const admin = new SQL(env.ADMIN_DATABASE_URL as string);
    try {
      const roles =
        (await admin`SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role'`) as unknown[];
      expect(roles).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

describe("the install's bootstrap.sh (#696 Phase 4c)", () => {
  it("runs as the Postgres entrypoint would and creates the agent's login, idempotently", async () => {
    const script = selfHostedBootstrapScript({ agent: true });
    for (let run = 0; run < 2; run++) {
      const proc = Bun.spawn(["sh", "-c", script], {
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...env,
          PGHOST: env.PGHOST ?? "localhost",
          PGPORT: env.POSTGRES_PORT,
          ...(env.POSTGRES_PASSWORD ? { PGPASSWORD: env.POSTGRES_PASSWORD } : {}),
          AGENT_ROLE_PASSWORD: "bootstrap-agent-pw",
        },
      });
      const stderr = await new Response(proc.stderr).text();
      expect({ exitCode: await proc.exited, stderr }).toEqual({ exitCode: 0, stderr: "" });
    }
    const agent = new SQL(
      `postgres://caelo_agent:bootstrap-agent-pw@${env.PGHOST ?? "localhost"}:${env.POSTGRES_PORT}/cms_admin`,
    );
    try {
      const rows = (await agent.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return tx`SELECT current_user::text AS u, count(*)::int AS n FROM platform_update_policy`;
      })) as { u: string; n: number }[];
      expect(rows[0]).toEqual({ u: "caelo_agent", n: 1 });
    } finally {
      await agent.end();
    }
    const dropped = await psql(
      "\\set ON_ERROR_STOP on\n\\connect cms_admin\nDROP OWNED BY caelo_agent;\n\\connect cms_public\nDROP OWNED BY caelo_agent;\n\\connect postgres\nDROP ROLE caelo_agent;\n",
    );
    expect(dropped).toEqual({ exitCode: 0, stderr: "" });
  });
});
