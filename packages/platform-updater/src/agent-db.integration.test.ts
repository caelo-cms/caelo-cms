// SPDX-License-Identifier: MPL-2.0
/**
 * The self-hosted host agent's database login against real Postgres (#696
 * Phase 4c, §6): the role convergence `cms-provision up` / `agent install`
 * run as the superuser creates `caelo_agent` as a member of
 * `platform_updater` and re-applies migrations 0267 + 0270's grants; the
 * agent then logs in over TCP exactly as on the host (openAgentQueue) and
 * must be able to do its whole run — heartbeat, claim, events, facts,
 * finish — and nothing else.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { OpenedAgentQueue } from "@caelo-cms/provisioning";
import { assessUpgradeRequest, roleConvergenceScript } from "@caelo-cms/provisioning";
import { SQL } from "bun";
import { openAgentQueue } from "./agent-db.js";

const env = process.env;
const required = [
  "POSTGRES_USER",
  "POSTGRES_PORT",
  "ADMIN_ROLE_PASSWORD",
  "PUBLIC_ROLE_PASSWORD",
  "GATEWAY_ROLE_PASSWORD",
  "ADMIN_DATABASE_URL",
] as const;
const missing = required.filter((name) => !env[name]);
if (missing.length > 0) throw new Error(`${missing.join(", ")} required (see .env.example)`);

const AGENT_PASSWORD = "agent-pw-'quoted";
const PORT = Number(env.POSTGRES_PORT);

/** psql as the superuser — the local equivalent of `docker compose exec postgres psql`. */
async function psql(script: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(
    [
      "psql",
      "-h",
      env.PGHOST ?? "localhost",
      "-p",
      String(PORT),
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
}

async function admin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const db = new SQL(env.ADMIN_DATABASE_URL as string);
  try {
    let result!: T;
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      result = await fn(tx as unknown as SQL);
    });
    return result;
  } finally {
    await db.end();
  }
}

/** Raw SQL as the agent's login, for the "may not" half (the queue only runs its ops). */
async function asAgent<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const db = new SQL(
    `postgres://caelo_agent:${encodeURIComponent(AGENT_PASSWORD)}@127.0.0.1:${PORT}/cms_admin`,
  );
  try {
    let result!: T;
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      result = await fn(tx as unknown as SQL);
    });
    return result;
  } finally {
    await db.end();
  }
}

let opened: OpenedAgentQueue;

beforeAll(async () => {
  const converged = await psql(
    roleConvergenceScript(
      {
        admin: env.ADMIN_ROLE_PASSWORD as string,
        public: env.PUBLIC_ROLE_PASSWORD as string,
        gateway: env.GATEWAY_ROLE_PASSWORD as string,
      },
      AGENT_PASSWORD,
    ),
  );
  expect(converged).toEqual({ exitCode: 0, stderr: "" });
  opened = await openAgentQueue({ user: "caelo_agent", password: AGENT_PASSWORD, port: PORT });
  await admin(async (tx) => {
    await tx`DELETE FROM platform_update_requests`;
    await tx`DELETE FROM platform_update_agent`;
  });
});

afterAll(async () => {
  await opened?.close();
  await admin(async (tx) => {
    await tx`DELETE FROM platform_update_requests`;
    await tx`DELETE FROM platform_update_agent`;
    await tx`UPDATE platform_update_policy SET paused = false, paused_reason = NULL, paused_at = NULL WHERE id = 1`;
  });
  // Leave the cluster as other suites expect it: no agent login.
  await psql(
    "\\set ON_ERROR_STOP on\n\\connect cms_admin\nDROP OWNED BY caelo_agent;\n\\connect cms_public\nDROP OWNED BY caelo_agent;\n\\connect postgres\nDROP ROLE caelo_agent;\n",
  );
});

describe("caelo_agent — the self-hosted update agent's login", () => {
  it("is an ordinary login that inherits platform_updater", async () => {
    const [attrs] = (await admin(
      (tx) => tx`
        SELECT r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreaterole, r.rolbypassrls,
               pg_has_role('caelo_agent', 'platform_updater', 'USAGE') AS member
          FROM pg_roles r WHERE r.rolname = 'caelo_agent'`,
    )) as unknown as Record<string, boolean>[];
    expect(attrs).toEqual({
      rolcanlogin: true,
      rolinherit: true,
      rolsuper: false,
      rolcreaterole: false,
      rolbypassrls: false,
      member: true,
    });
  });

  it("checks in, claims, narrates, records and finishes through the Query API", async () => {
    const { queue } = opened;
    await queue.heartbeat({ agentVersion: "0.10.47", host: "box-1", problem: null });
    await queue.heartbeat({ agentVersion: "0.10.47", host: "box-1", problem: "cosign missing" });
    const beats = (await admin(
      (tx) => tx`SELECT agent_version, host, problem FROM platform_update_agent`,
    )) as unknown as Record<string, string>[];
    expect(beats).toEqual([{ agent_version: "0.10.47", host: "box-1", problem: "cosign missing" }]);

    const [{ id }] = (await admin(
      (tx) => tx`
        INSERT INTO platform_update_requests (target_version, from_version, trigger)
        VALUES ('99.0.1', '0.10.47', 'auto') RETURNING id::text AS id`,
    )) as unknown as { id: string }[];
    const claimed = await queue.claim("agent@box-1");
    expect(claimed).toMatchObject({ id, targetVersion: "99.0.1", trigger: "auto" });
    await queue.event(id, "verify", "success", "verified");
    await queue.record(id, { adminDigest: `sha256:${"a".repeat(64)}`, manifestSecurity: false });
    expect(
      await queue.finish(id, {
        status: "refused",
        reason: "policy",
        codes: ["policy"],
        pauseAutoUpdates: false,
      }),
    ).toBe(true);
    // Already ended: nothing changes.
    expect(
      await queue.finish(id, {
        status: "failed",
        reason: "x",
        codes: ["apply"],
        pauseAutoUpdates: false,
      }),
    ).toBe(false);
    const [row] = (await admin(
      (tx) =>
        tx`SELECT status, execution, admin_digest FROM platform_update_requests WHERE id = ${id}::uuid`,
    )) as unknown as Record<string, string>[];
    expect(row).toEqual({
      status: "refused",
      execution: "agent@box-1",
      admin_digest: `sha256:${"a".repeat(64)}`,
    });
  });

  it("picks up the scheduler's automatic request with its basis and the whole policy (#696 Phase 5)", async () => {
    const { queue } = opened;
    await admin(async (tx) => {
      await tx`DELETE FROM platform_update_requests`;
      // An Owner pause that has run out; the scheduler lifts it on its next
      // tick, the agent must not wait for that.
      await tx`
        UPDATE platform_update_policy
           SET mode = 'auto', auto_patch = true, security_soak_hours = 1, paused = true,
               paused_at = now() - interval '8 days', paused_until = now() - interval '1 hour',
               paused_reason = 'launch week'
         WHERE id = 1`;
    });
    try {
      // The row platform_updates.scheduler_tick writes: no requester, an auto basis.
      const [{ id }] = (await admin(
        (tx) => tx`
          INSERT INTO platform_update_requests (target_version, from_version, trigger, auto_basis)
          VALUES ('99.0.1', '99.0.0', 'auto', 'patch') RETURNING id::text AS id`,
      )) as unknown as { id: string }[];
      const claimed = await queue.claim("agent@box-1");
      expect(claimed).toMatchObject({
        id,
        targetVersion: "99.0.1",
        trigger: "auto",
        autoBasis: "patch",
        policy: {
          mode: "auto",
          autoPatch: true,
          securitySoakHours: 1,
          paused: true,
          pausedByOwner: false,
        },
      });
      expect(Date.parse(claimed?.policy.pausedUntil ?? "")).toBeLessThan(Date.now());
      if (!claimed) throw new Error("nothing claimed");

      // What the agent decides with it (agent/run.ts): installed as an automatic run.
      const decision = assessUpgradeRequest({
        request: claimed,
        manifest: {
          ok: true,
          manifest: {
            manifestVersion: 1,
            version: "99.0.1",
            channel: "stable",
            digests: {
              admin: `sha256:${"a".repeat(64)}`,
              gateway: `sha256:${"b".repeat(64)}`,
              ops: `sha256:${"c".repeat(64)}`,
            },
            minFromVersion: "99.0.0",
            infraContractVersion: 1,
            migrations: {
              contract: false,
              lastContractVersion: null,
              head: "0271_platform_auto_updates",
            },
            security: false,
            advisories: [],
          },
        },
        installed: { version: "99.0.0", infraContractVersion: null },
        policy: claimed.policy,
        now: new Date(),
        manualPath: "server",
      });
      expect(decision.kind).toBe("proceed");
    } finally {
      await admin(
        (tx) => tx`
          UPDATE platform_update_policy
             SET mode = 'notify', auto_patch = false, security_soak_hours = 2, paused = false,
                 paused_at = NULL, paused_until = NULL, paused_reason = NULL
           WHERE id = 1`,
      );
    }
  });

  it("can touch nothing else", async () => {
    const denied = async (fn: (tx: SQL) => Promise<unknown>) => {
      try {
        await asAgent(fn);
        return "allowed";
      } catch (e) {
        return String((e as Error).message);
      }
    };
    expect(await denied((tx) => tx`SELECT id FROM users LIMIT 1`)).toContain("permission denied");
    expect(await denied((tx) => tx`SELECT * FROM ai_providers LIMIT 1`)).toContain(
      "permission denied",
    );
    // Target and requester stay as the Owner set them.
    expect(
      await denied((tx) => tx`UPDATE platform_update_requests SET target_version = '0.0.1'`),
    ).toContain("permission denied");
    expect(await denied((tx) => tx`DELETE FROM platform_update_requests`)).toContain(
      "permission denied",
    );
    // Only the pause of the policy, never the policy itself.
    expect(await denied((tx) => tx`UPDATE platform_update_policy SET mode = 'auto'`)).toContain(
      "permission denied",
    );
  });
});
