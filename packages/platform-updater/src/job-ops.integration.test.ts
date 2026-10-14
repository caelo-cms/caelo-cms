// SPDX-License-Identifier: MPL-2.0

/**
 * The upgrader job's ops against real Postgres (§6), each run under the
 * `platform_updater` role the job connects as (migration 0267): the role's
 * grants must be enough for the whole run — claim, events, facts, finish,
 * the pause, the audit row — and the queue must drive them in order.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, SYSTEM_ACTOR_ID } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { createDbUpdateQueue } from "./db-queue.js";
import { jobClaimOp, jobEventOp, jobFinishOp, jobRecordOp } from "./ops.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "platform-updater-int",
};

let adapter: DatabaseAdapter;

async function admin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const db = new SQL(ADMIN_URL as string);
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

/** Run an op handler as the platform_updater role (what the job's IAM user is a member of). */
function asUpdater<T>(fn: Parameters<DatabaseAdapter["withAdminTransaction"]>[1]): Promise<T> {
  return adapter.withAdminTransaction(SYSTEM, async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE platform_updater`);
    return fn(tx);
  }) as Promise<T>;
}

async function addRequest(version: string, opts: { runningSince?: string } = {}): Promise<string> {
  const rows = await admin(
    (tx) => tx`
      INSERT INTO platform_update_requests (target_version, from_version, trigger, status, started_at)
      VALUES (${version}, '0.10.45', 'auto', ${opts.runningSince ? "running" : "pending"},
              ${opts.runningSince ?? null}::timestamptz)
      RETURNING id::text AS id`,
  );
  return (rows as unknown as { id: string }[])[0]?.id as string;
}

async function request(id: string) {
  const rows = await admin(
    (tx) => tx`SELECT status, status_reason, refusal_codes, execution, backup_id, ops_digest
                 FROM platform_update_requests WHERE id = ${id}::uuid`,
  );
  return (rows as unknown as Record<string, unknown>[])[0];
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
});

beforeEach(async () => {
  await admin(async (tx) => {
    await tx`DELETE FROM platform_update_requests`;
    await tx`UPDATE platform_update_policy SET paused = false, paused_reason = NULL, paused_at = NULL WHERE id = 1`;
  });
});

afterAll(async () => {
  await admin(async (tx) => {
    await tx`DELETE FROM platform_update_requests`;
    await tx`UPDATE platform_update_policy SET paused = false, paused_reason = NULL, paused_at = NULL WHERE id = 1`;
  });
  await adapter.close();
});

describe("upgrader job ops as platform_updater", () => {
  it("claims, narrates, records and finishes a run", async () => {
    const id = await addRequest("99.0.1");
    const claim = await asUpdater<{ ok: boolean; value: { claimed: { id: string } | null } }>(
      (tx) => jobClaimOp.handler(SYSTEM, { execution: "exec-7" }, tx),
    );
    expect(claim.ok && claim.value.claimed?.id).toBe(id);
    expect(await request(id)).toMatchObject({ status: "running", execution: "exec-7" });

    const event = await asUpdater<{ ok: boolean }>((tx) =>
      jobEventOp.handler(
        SYSTEM,
        { requestId: id, phase: "verify", level: "info", message: "ok" },
        tx,
      ),
    );
    expect(event.ok).toBe(true);
    const record = await asUpdater<{ ok: boolean }>((tx) =>
      jobRecordOp.handler(
        SYSTEM,
        { requestId: id, facts: { backupId: "123", opsDigest: `sha256:${"c".repeat(64)}` } },
        tx,
      ),
    );
    expect(record.ok).toBe(true);
    const finish = await asUpdater<{ ok: boolean; value: { finished: boolean } }>((tx) =>
      jobFinishOp.handler(
        SYSTEM,
        {
          requestId: id,
          status: "rolled_back",
          reason: "unhealthy",
          codes: ["health"],
          pauseAutoUpdates: true,
        },
        tx,
      ),
    );
    expect(finish.ok && finish.value.finished).toBe(true);
    expect(await request(id)).toMatchObject({
      status: "rolled_back",
      status_reason: "unhealthy",
      refusal_codes: ["health"],
      backup_id: "123",
    });
    const policy = await admin(
      (tx) => tx`SELECT paused, paused_reason FROM platform_update_policy`,
    );
    expect((policy as unknown as { paused: boolean; paused_reason: string }[])[0]).toMatchObject({
      paused: true,
    });
    const audit = await admin(
      (tx) => tx`SELECT succeeded, result_summary FROM audit_events
                  WHERE operation = 'platform_updates.job_finish' AND entity_id = ${id}`,
    );
    expect((audit as unknown as { result_summary: string }[])[0]?.result_summary).toBe(
      "rolled_back (health)",
    );
  });

  it("ends a run that died before claiming the next", async () => {
    const dead = await addRequest("99.0.1", { runningSince: "2026-01-01T00:00:00Z" });
    await admin(
      (tx) => tx`UPDATE platform_update_requests SET status = 'running' WHERE id = ${dead}::uuid`,
    );
    const claim = await asUpdater<{
      ok: boolean;
      value: { recovered: string[]; claimed: unknown };
    }>((tx) => jobClaimOp.handler(SYSTEM, { execution: null }, tx));
    expect(claim.ok && claim.value.recovered).toEqual([dead]);
    expect(claim.ok && claim.value.claimed).toBeNull();
    expect(await request(dead)).toMatchObject({ status: "failed", refusal_codes: ["stale"] });
    // A dead automatic install pauses automatic installs.
    const policy = await admin((tx) => tx`SELECT paused FROM platform_update_policy`);
    expect((policy as unknown as { paused: boolean }[])[0]?.paused).toBe(true);
  });
});

describe("createDbUpdateQueue", () => {
  it("drives the ops through the Query API", async () => {
    const id = await addRequest("99.0.2");
    // Phase 5: the scheduler names why it queued the request; the job gets it.
    await admin(
      (tx) => tx`UPDATE platform_update_requests SET auto_basis = 'patch' WHERE id = ${id}::uuid`,
    );
    const queue = createDbUpdateQueue(adapter);
    const claimed = await queue.claim("exec-8");
    expect(claimed).toMatchObject({
      id,
      targetVersion: "99.0.2",
      trigger: "auto",
      autoBasis: "patch",
    });
    expect(claimed?.policy).toMatchObject({
      soakHours: 24,
      securitySoakHours: 2,
      pausedUntil: null,
      pausedByOwner: false,
    });
    await queue.event(id, "start", "info", "hello");
    await queue.record(id, { manifestSecurity: true });
    await queue.finish(id, {
      status: "succeeded",
      reason: null,
      codes: [],
      pauseAutoUpdates: false,
    });
    expect(await request(id)).toMatchObject({ status: "succeeded" });
    expect(await queue.claim(null)).toBeNull();
  });
});
