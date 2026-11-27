// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — the reporting-job ops (migration 0680) and the admin's
 * report handler against a real Postgres:
 *
 *   - an attempt starts once; the next one only after the last one's lease
 *     ran out, with a new token; after the last attempt the work is
 *     exhausted; finished work starts no attempt;
 *   - a report is admitted only with the current attempt's token; an older
 *     attempt is told it is stale, finished work that it is over; the rate
 *     is capped per minute; every admitted report extends the lease;
 *   - an input in parts is read back whole, and only complete and from the
 *     attempt that sent it; a restart drops what an earlier attempt left;
 *   - the backstop's read lists only running work whose lease ran out;
 *     finished rows are swept after their retention;
 *   - the handler refuses what it cannot admit before any action runs;
 *   - only the system actor reaches the tables.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { handleJobReport } from "../reporting-jobs/dispatch.js";
import { hashJobToken, MAX_REPORT_BODY_BYTES, mintJobToken } from "../reporting-jobs/protocol.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1359",
};
const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-4000-8000-000000001359",
  actorKind: "human",
  requestId: "t1359",
};
const KIND = "quality_audit";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function op<T>(name: string, input: unknown, ctx: ExecutionContext = SYS): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

function subject(): string {
  return crypto.randomUUID();
}

async function begin(subjectId: string, token = mintJobToken(), maxAttempts = 3) {
  const r = await op<{
    started: boolean;
    attempt: number;
    reason?: string;
    lastError?: string | null;
    execution?: string | null;
  }>("reporting_jobs.begin_attempt", {
    kind: KIND,
    subjectId,
    tokenHash: hashJobToken(token),
    leaseSeconds: 60,
    maxAttempts,
  });
  return { ...r, token };
}

async function expire(subjectId: string): Promise<void> {
  await asSystem(
    (tx) =>
      tx`UPDATE reporting_jobs SET lease_until = now() - interval '1 second' WHERE kind = ${KIND} AND subject_id = ${subjectId}::uuid`,
  );
}

async function row(subjectId: string) {
  const rows = (await asSystem(
    (tx) => tx`
      SELECT attempt, state, execution, last_error,
             extract(epoch FROM lease_until - now())::float AS lease_left_s
      FROM reporting_jobs WHERE kind = ${KIND} AND subject_id = ${subjectId}::uuid`,
  )) as {
    attempt: number;
    state: string;
    execution: string | null;
    last_error: string | null;
    lease_left_s: number;
  }[];
  return rows[0];
}

const authorize = (subjectId: string, attempt: number, token: string, ratePerMinute = 600) =>
  op<{ admitted: boolean; reason?: string; retryAfterSeconds?: number }>(
    "reporting_jobs.authorize",
    {
      kind: KIND,
      subjectId,
      attempt,
      tokenHash: hashJobToken(token),
      leaseSeconds: 300,
      ratePerMinute,
    },
  );

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

beforeEach(async () => {
  await asSystem((tx) => tx`DELETE FROM reporting_jobs`);
});

afterAll(async () => {
  await asSystem((tx) => tx`DELETE FROM reporting_jobs`);
  await adapter.close();
});

describe("reporting_jobs.begin_attempt", () => {
  it("starts the first attempt once; a second start while it runs is refused", async () => {
    const s = subject();
    expect((await begin(s)).started).toBe(true);
    expect(await row(s)).toMatchObject({ attempt: 1, state: "running" });
    const again = await begin(s);
    expect(again).toMatchObject({ started: false, reason: "running", attempt: 1 });
  });

  it("starts the next attempt once the lease ran out, with a new token, and drops the old attempt's uploads", async () => {
    const s = subject();
    const first = await begin(s);
    await op("reporting_jobs.record_launch", {
      kind: KIND,
      subjectId: s,
      attempt: 1,
      execution: "exec-1",
    });
    await op("reporting_jobs.release", {
      kind: KIND,
      subjectId: s,
      attempt: 1,
      reason: "could not be started: x",
    });
    await op("reporting_jobs.put_upload_part", {
      kind: KIND,
      subjectId: s,
      attempt: 1,
      uploadId: "00000000-0000-4000-8000-0000000000aa",
      part: 0,
      data: "[1]",
    });
    const second = await begin(s);
    expect(second).toMatchObject({ started: true, attempt: 2 });
    // The new attempt starts clean: no execution yet, no reason of the last one.
    expect(await row(s)).toMatchObject({ attempt: 2, execution: null, last_error: null });
    expect((await authorize(s, 2, first.token)).reason).toBe("bad-token");
    expect((await authorize(s, 2, second.token)).admitted).toBe(true);
    const parts = (await asSystem(
      (tx) =>
        tx`SELECT count(*)::int AS n FROM reporting_job_uploads WHERE subject_id = ${s}::uuid`,
    )) as { n: number }[];
    expect(parts[0]?.n).toBe(0);
  });

  it("after the last attempt the work is exhausted, naming how the last one ended", async () => {
    const s = subject();
    await begin(s, mintJobToken(), 2);
    await expire(s);
    await begin(s, mintJobToken(), 2);
    await op("reporting_jobs.record_launch", {
      kind: KIND,
      subjectId: s,
      attempt: 2,
      execution: "exec-2",
    });
    await op("reporting_jobs.release", {
      kind: KIND,
      subjectId: s,
      attempt: 2,
      reason: "deferred: old image",
    });
    expect(await begin(s, mintJobToken(), 2)).toMatchObject({
      started: false,
      reason: "exhausted",
      attempt: 2,
      lastError: "deferred: old image",
      execution: "exec-2",
    });
  });

  it("finished work starts no attempt and admits no report", async () => {
    const s = subject();
    const b = await begin(s);
    expect(
      (
        await op<{ finished: boolean }>("reporting_jobs.finish", {
          kind: KIND,
          subjectId: s,
          attempt: 1,
          outcome: "completed",
          note: null,
        })
      ).finished,
    ).toBe(true);
    await expire(s);
    expect((await begin(s)).reason).toBe("finished");
    expect((await authorize(s, 1, b.token)).reason).toBe("finished");
    // Finishing twice changes nothing.
    expect(
      (
        await op<{ finished: boolean }>("reporting_jobs.finish", {
          kind: KIND,
          subjectId: s,
          attempt: null,
          outcome: "given-up",
          note: "late",
        })
      ).finished,
    ).toBe(false);
  });
});

describe("reporting_jobs.authorize", () => {
  it("admits the current attempt's token and extends the lease", async () => {
    const s = subject();
    const b = await begin(s);
    expect((await row(s))?.lease_left_s).toBeLessThan(61);
    expect((await authorize(s, 1, b.token)).admitted).toBe(true);
    expect((await row(s))?.lease_left_s).toBeGreaterThan(290);
  });

  it("tells a replaced attempt it is stale, and refuses an unknown run or a wrong token", async () => {
    const s = subject();
    const first = await begin(s);
    await expire(s);
    await begin(s);
    expect((await authorize(s, 1, first.token)).reason).toBe("stale");
    expect((await authorize(s, 2, first.token)).reason).toBe("bad-token");
    expect((await authorize(s, 3, first.token)).reason).toBe("bad-token");
    expect((await authorize(subject(), 1, first.token)).reason).toBe("unknown");
  });

  it("caps the reports per minute and says when to come back", async () => {
    const s = subject();
    const b = await begin(s);
    expect((await authorize(s, 1, b.token, 2)).admitted).toBe(true);
    expect((await authorize(s, 1, b.token, 2)).admitted).toBe(true);
    const third = await authorize(s, 1, b.token, 2);
    expect(third.reason).toBe("rate-limited");
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(third.retryAfterSeconds).toBeLessThanOrEqual(60);
    // A new window admits again.
    await asSystem(
      (tx) =>
        tx`UPDATE reporting_jobs SET window_started_at = now() - interval '61 seconds' WHERE subject_id = ${s}::uuid`,
    );
    expect((await authorize(s, 1, b.token, 2)).admitted).toBe(true);
  });
});

describe("uploads", () => {
  const UPLOAD = "00000000-0000-4000-8000-0000000000bb";

  it("reads the parts back whole, in order, whatever order they came in", async () => {
    const s = subject();
    await begin(s);
    for (const [part, data] of [
      [1, '"b",'],
      [0, '["a",'],
      [2, '"c"]'],
    ] as const) {
      await op("reporting_jobs.put_upload_part", {
        kind: KIND,
        subjectId: s,
        attempt: 1,
        uploadId: UPLOAD,
        part,
        data,
      });
    }
    // A part sent twice (its answer was lost) replaces itself.
    await op("reporting_jobs.put_upload_part", {
      kind: KIND,
      subjectId: s,
      attempt: 1,
      uploadId: UPLOAD,
      part: 2,
      data: '"c"]',
    });
    const take = { kind: KIND, subjectId: s, attempt: 1, uploadId: UPLOAD, parts: 3 };
    const read = await op<{ text: string }>("reporting_jobs.read_upload", take);
    expect(JSON.parse(read.text)).toEqual(["a", "b", "c"]);
    // Read once: the run's uploads stay small however many it sends.
    expect((await execute(registry, adapter, SYS, "reporting_jobs.read_upload", take)).ok).toBe(
      false,
    );
  });

  it("refuses an incomplete upload or one an earlier attempt sent", async () => {
    const s = subject();
    await begin(s);
    await op("reporting_jobs.put_upload_part", {
      kind: KIND,
      subjectId: s,
      attempt: 1,
      uploadId: UPLOAD,
      part: 0,
      data: "[",
    });
    const incomplete = await execute(registry, adapter, SYS, "reporting_jobs.read_upload", {
      kind: KIND,
      subjectId: s,
      attempt: 1,
      uploadId: UPLOAD,
      parts: 2,
    });
    expect(incomplete.ok).toBe(false);
    const otherAttempt = await execute(registry, adapter, SYS, "reporting_jobs.read_upload", {
      kind: KIND,
      subjectId: s,
      attempt: 2,
      uploadId: UPLOAD,
      parts: 1,
    });
    expect(otherAttempt.ok).toBe(false);
  });
});

describe("the backstop's reads", () => {
  it("lists only running work of the kind whose lease ran out, oldest lease first", async () => {
    const [a, b, c] = [subject(), subject(), subject()];
    await begin(a);
    await begin(b);
    await begin(c);
    await expire(b);
    await expire(a);
    await op("reporting_jobs.finish", {
      kind: KIND,
      subjectId: a,
      attempt: 1,
      outcome: "completed",
      note: null,
    });
    const listed = await op<{ jobs: { subjectId: string; attempt: number }[] }>(
      "reporting_jobs.list_expired",
      { kind: KIND, limit: 10 },
    );
    expect(listed.jobs.map((j) => j.subjectId)).toEqual([b]);
  });

  it("sweeps finished rows past their retention, and nothing else", async () => {
    const [old, recent, running] = [subject(), subject(), subject()];
    for (const s of [old, recent, running]) await begin(s);
    for (const s of [old, recent]) {
      await op("reporting_jobs.finish", {
        kind: KIND,
        subjectId: s,
        attempt: 1,
        outcome: "completed",
        note: null,
      });
    }
    await asSystem(
      (tx) =>
        tx`UPDATE reporting_jobs SET finished_at = now() - interval '8 days' WHERE subject_id = ${old}::uuid`,
    );
    expect(
      (await op<{ deleted: number }>("reporting_jobs.sweep", { olderThanDays: 7, limit: 100 }))
        .deleted,
    ).toBe(1);
    expect(await row(old)).toBeUndefined();
    expect(await row(recent)).toBeDefined();
    expect(await row(running)).toBeDefined();
  });
});

describe("handleJobReport", () => {
  const report = (kind: string, token: string | null, body: unknown) =>
    handleJobReport(
      { adapter, registry },
      { kind, token, bodyText: typeof body === "string" ? body : JSON.stringify(body) },
    );

  it("refuses what it cannot admit before any action runs", async () => {
    const s = subject();
    const b = await begin(s);
    const envelope = { subjectId: s, attempt: 1, action: "heartbeat" };
    expect((await report("mystery", b.token, envelope)).status).toBe(404);
    expect((await report(KIND, b.token, "{not json")).status).toBe(400);
    expect((await report(KIND, b.token, { ...envelope, extra: true })).status).toBe(400);
    expect((await report(KIND, null, envelope)).status).toBe(401);
    expect((await report(KIND, mintJobToken(), envelope)).status).toBe(401);
    expect((await report(KIND, b.token, "x".repeat(MAX_REPORT_BODY_BYTES + 1))).status).toBe(413);
    expect((await report(KIND, b.token, { ...envelope, action: "no-such" })).status).toBe(404);
    expect(
      (await report(KIND, b.token, { ...envelope, action: "source", payload: { name: "secrets" } }))
        .status,
    ).toBe(400);
    expect((await report(KIND, b.token, envelope)).status).toBe(200);
  });

  it("a deferral gives the attempt back at once, with its reason", async () => {
    const s = subject();
    const b = await begin(s);
    const r = await report(KIND, b.token, {
      subjectId: s,
      attempt: 1,
      action: "defer",
      payload: { reason: "the job runs Caelo 0.11.9" },
    });
    expect(r.status).toBe(200);
    expect(await row(s)).toMatchObject({ last_error: "deferred: the job runs Caelo 0.11.9" });
    expect((await row(s))?.lease_left_s).toBeLessThanOrEqual(0);
  });

  it("takes an input in parts through upload-part, then the action naming the upload", async () => {
    const s = subject();
    const b = await begin(s);
    const uploadId = "00000000-0000-4000-8000-0000000000cc";
    // The never-live read with its page ids sent in two parts.
    const text = JSON.stringify({ name: "neverLivePageIds", pageIds: [] });
    const half = Math.floor(text.length / 2);
    for (const [part, data] of [text.slice(0, half), text.slice(half)].entries()) {
      const r = await report(KIND, b.token, {
        subjectId: s,
        attempt: 1,
        action: "upload-part",
        payload: { uploadId, part, data },
      });
      expect(r.status).toBe(200);
    }
    const r = await report(KIND, b.token, {
      subjectId: s,
      attempt: 1,
      action: "source",
      upload: { uploadId, parts: 2 },
    });
    expect(r).toEqual({ status: 200, answer: { ok: true, value: [] } });
    // A part missing: a clean refusal, not a crash.
    const missing = await report(KIND, b.token, {
      subjectId: s,
      attempt: 1,
      action: "source",
      upload: { uploadId: "00000000-0000-4000-8000-0000000000dd", parts: 1 },
    });
    expect(missing.status).toBe(400);
  });
});

describe("row-level security", () => {
  it("only the system actor reaches the ops and the tables", async () => {
    const s = subject();
    const r = await execute(registry, adapter, HUMAN, "reporting_jobs.begin_attempt", {
      kind: KIND,
      subjectId: s,
      tokenHash: hashJobToken(mintJobToken()),
      leaseSeconds: 60,
      maxAttempts: 3,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("ActorScopeRejected");
    await begin(s);
    const sql = new SQL(ADMIN_URL as string);
    try {
      const seen = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'human'");
        return (await tx`SELECT count(*)::int AS n FROM reporting_jobs`) as { n: number }[];
      });
      expect(seen[0]?.n).toBe(0);
    } finally {
      await sql.end();
    }
  });
});
