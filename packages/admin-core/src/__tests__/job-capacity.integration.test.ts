// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1776 — the job capacity ledger (migration 0920) against a real
 * Postgres:
 *
 *   - an immediate job always runs; a stage or background job waits when
 *     the budget is full, says why, and holds back the jobs behind it;
 *   - the admission starts a waiting job once CPU is free, and adds helpers
 *     (with tokens of their own, which `reporting_jobs.authorize` admits for
 *     their attempt) to elastic work whose attempt runs;
 *   - a quality check keeps its Lighthouse share, and a batch books its width;
 *   - pieces are claimed once each, a claim that ran out is open again, and
 *     a helper over its work's grant hears `stop` and gives its task back;
 *   - a work's bookings and pieces end with it, a new attempt drops the old
 *     one's helpers, and the sweep gives back what stopped without a word;
 *   - people and the AI read the ledger, only the system writes it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { auditReserveVcpu, SERVICE_RESERVE_VCPU } from "../job-capacity/plan.js";
import type { CapacityBooking } from "../ops/job_capacity.js";
import { registerAdminOps } from "../register.js";
import { hashJobToken, mintJobToken } from "../reporting-jobs/protocol.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1776",
};
const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-4000-8000-000000001776",
  actorKind: "human",
  requestId: "t1776",
};

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

/** A new project's 20 vCPU: 14 for the jobs. */
async function budget(quotaVcpu: number | null = 20) {
  await op("job_capacity.set_budget", {
    source: "quota",
    budgetVcpu: quotaVcpu === null ? null : quotaVcpu - SERVICE_RESERVE_VCPU,
    quotaVcpu,
    reserveVcpu: SERVICE_RESERVE_VCPU,
    projectId: "acme",
    region: "europe-west1",
  });
}

type BookInput = {
  kind: string;
  cls: "immediate" | "stage" | "background";
  vcpuPerTask: number;
  elastic?: boolean;
  maxTasks?: number;
  auditReserve?: boolean;
  role?: "lead" | "capture";
  leaseSeconds?: number;
};

async function book(subjectId: string, b: BookInput) {
  return op<{ bookingId: string; state: "running" | "waiting"; reason: string | null }>(
    "job_capacity.book",
    {
      subjectId,
      role: b.role ?? "lead",
      elastic: false,
      maxTasks: 1,
      auditReserve: false,
      ...b,
    },
  );
}

const index = (subjectId: string) =>
  book(subjectId, {
    kind: "collection_index",
    cls: "stage",
    vcpuPerTask: 2,
    elastic: true,
    maxTasks: 32,
  });

/** A running attempt of `kind` on `subjectId`, launched (what the admission widens). */
async function runningAttempt(kind: string, subjectId: string, token = mintJobToken()) {
  await op("reporting_jobs.begin_attempt", {
    kind,
    subjectId,
    tokenHash: hashJobToken(token),
    leaseSeconds: 600,
    maxAttempts: 8,
  });
  await op("reporting_jobs.record_launch", { kind, subjectId, attempt: 1, execution: "exec-1" });
  return token;
}

async function bookings() {
  return (await op<{ bookings: CapacityBooking[] }>("job_capacity.list", {})).bookings;
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

beforeEach(async () => {
  await asSystem(async (tx) => {
    await tx`DELETE FROM job_pieces`;
    await tx`DELETE FROM job_capacity_bookings`;
    await tx`DELETE FROM job_capacity_budget`;
    await tx`DELETE FROM reporting_jobs`;
  });
});

afterAll(async () => {
  await asSystem(async (tx) => {
    await tx`DELETE FROM job_pieces`;
    await tx`DELETE FROM job_capacity_bookings`;
    await tx`DELETE FROM job_capacity_budget`;
    await tx`DELETE FROM reporting_jobs`;
  });
  await adapter.close();
});

describe("job_capacity.book", () => {
  it("runs an immediate job at once, even before any budget was read", async () => {
    expect(
      await book(crypto.randomUUID(), { kind: "build", cls: "immediate", vcpuPerTask: 1 }),
    ).toMatchObject({
      state: "running",
      reason: null,
    });
  });

  it("refuses to plan a job that may wait without a budget", async () => {
    await expect(index(crypto.randomUUID())).rejects.toThrow(/no CPU budget was read yet/);
  });

  it("starts the check and one index task on a new project, and keeps the check's share free", async () => {
    await budget(20);
    const audit = crypto.randomUUID();
    expect(
      await book(audit, {
        kind: "quality_audit",
        cls: "immediate",
        vcpuPerTask: 1,
        auditReserve: true,
      }),
    ).toMatchObject({ state: "running" });
    expect(await index(crypto.randomUUID())).toMatchObject({ state: "running" });
    const listed = await bookings();
    expect(listed.find((b) => b.kind === "quality_audit")?.reserveVcpu).toBe(auditReserveVcpu(14));
  });

  it("lets a job wait when the budget is full, says why, and holds back the jobs behind it", async () => {
    await budget(20);
    // A 14-vCPU import fills the budget (immediate jobs always run).
    await book(crypto.randomUUID(), { kind: "site_import", cls: "immediate", vcpuPerTask: 8 });
    await book(crypto.randomUUID(), { kind: "site_import", cls: "immediate", vcpuPerTask: 6 });
    const first = await index(crypto.randomUUID());
    expect(first.state).toBe("waiting");
    expect(first.reason).toBe(
      "waits for 2 vCPU: 0 of 14 vCPU are free (in use: the site import 14)",
    );
    const behind = await book(crypto.randomUUID(), {
      kind: "plugin_batch",
      cls: "background",
      vcpuPerTask: 1,
    });
    expect(behind.state).toBe("waiting");
    expect(behind.reason).toContain("behind the search index, which waits too");
  });

  it("finds a work's lead again instead of booking it twice", async () => {
    await budget(20);
    const s = crypto.randomUUID();
    const a = await index(s);
    const b = await index(s);
    expect(b).toEqual(a);
    expect((await bookings()).filter((x) => x.subjectId === s)).toHaveLength(1);
  });
});

describe("job_capacity.admit", () => {
  it("starts a waiting job once its blocker's work finished", async () => {
    await budget(20);
    const big = crypto.randomUUID();
    await runningAttempt("site_import", big);
    await book(big, { kind: "site_import", cls: "immediate", vcpuPerTask: 8 });
    await book(crypto.randomUUID(), { kind: "build", cls: "immediate", vcpuPerTask: 6 });
    const waiting = crypto.randomUUID();
    expect((await index(waiting)).state).toBe("waiting");
    expect(await op("job_capacity.admit", {})).toEqual({ leads: [], helpers: [] });
    await op("reporting_jobs.finish", {
      kind: "site_import",
      subjectId: big,
      attempt: 1,
      outcome: "completed",
      note: null,
    });
    expect((await op<{ leads: unknown[] }>("job_capacity.admit", {})).leads).toEqual([
      { kind: "collection_index", subjectId: waiting },
    ]);
  });

  it("adds helpers to elastic work whose attempt runs, each with a token its attempt admits", async () => {
    await budget(20);
    const s = crypto.randomUUID();
    await index(s);
    // Without a launched attempt, no helper: it would serve nobody.
    expect((await op<{ helpers: unknown[] }>("job_capacity.admit", {})).helpers).toEqual([]);
    const leadToken = await runningAttempt("collection_index", s);
    await op("job_pieces.register", {
      kind: "collection_index",
      subjectId: s,
      scope: "p/pages",
      count: 40,
      done: [],
      wantedTasks: 32,
      resetClaims: true,
    });
    const r = await op<{
      helpers: { bookingId: string; tasks: number; token: string; attempt: number }[];
    }>("job_capacity.admit", {});
    // 14 − 2 (the lead) − 2 (headroom) = 10: five more tasks.
    expect(r.helpers.map((h) => [h.tasks, h.attempt])).toEqual([[5, 1]]);
    const helper = r.helpers[0] as { bookingId: string; token: string };
    const authorize = (token: string) =>
      op<{ admitted: boolean; helperId?: string | null; reason?: string }>(
        "reporting_jobs.authorize",
        {
          kind: "collection_index",
          subjectId: s,
          attempt: 1,
          tokenHash: hashJobToken(token),
          leaseSeconds: 300,
          ratePerMinute: 600,
        },
      );
    expect(await authorize(helper.token)).toEqual({ admitted: true, helperId: helper.bookingId });
    expect(await authorize(leadToken)).toEqual({ admitted: true, helperId: null });
    expect(await authorize(mintJobToken())).toMatchObject({ admitted: false, reason: "bad-token" });
    const listed = (await bookings()).find((b) => b.subjectId === s);
    expect(listed).toMatchObject({ tasks: 6, wantedTasks: 32, vcpu: 12 });
    // The next admission adds nothing: the budget is used.
    expect((await op<{ helpers: unknown[] }>("job_capacity.admit", {})).helpers).toEqual([]);
  });
});

describe("a work's attempts and end", () => {
  it("a new attempt drops the old one's helpers and batches; the end drops everything", async () => {
    await budget(20);
    const s = crypto.randomUUID();
    await index(s);
    await runningAttempt("collection_index", s);
    await op("job_pieces.register", {
      kind: "collection_index",
      subjectId: s,
      scope: "p/pages",
      count: 10,
      done: [3],
      wantedTasks: 4,
      resetClaims: true,
    });
    await op("job_capacity.admit", {});
    expect((await bookings())[0]?.tasks).toBe(4);
    await asSystem(
      (tx) =>
        tx`UPDATE reporting_jobs SET lease_until = now() - interval '1 second' WHERE subject_id = ${s}::uuid`,
    );
    await op("reporting_jobs.begin_attempt", {
      kind: "collection_index",
      subjectId: s,
      tokenHash: hashJobToken(mintJobToken()),
      leaseSeconds: 600,
      maxAttempts: 8,
    });
    expect((await bookings())[0]?.tasks).toBe(1);
    await op("reporting_jobs.finish", {
      kind: "collection_index",
      subjectId: s,
      attempt: 2,
      outcome: "completed",
      note: null,
    });
    expect(await bookings()).toEqual([]);
    const pieces = await asSystem(
      (tx) => tx`SELECT count(*)::int AS n FROM job_pieces WHERE subject_id = ${s}::uuid`,
    );
    expect((pieces as { n: number }[])[0]?.n).toBe(0);
  });

  it("gives up waiting work that never started, and a stopped one leaves the queue", async () => {
    // 10 vCPU: 4 for the jobs.
    await budget(10);
    await book(crypto.randomUUID(), { kind: "build", cls: "immediate", vcpuPerTask: 4 });
    const given = crypto.randomUUID();
    expect((await index(given)).state).toBe("waiting");
    await op("reporting_jobs.finish", {
      kind: "collection_index",
      subjectId: given,
      attempt: null,
      outcome: "given-up",
      note: "gone",
    });
    const stopped = crypto.randomUUID();
    expect(
      (await book(stopped, { kind: "plugin_batch", cls: "background", vcpuPerTask: 1 })).state,
    ).toBe("waiting");
    expect(await op("job_capacity.cancel", { kind: "plugin_batch", subjectId: stopped })).toEqual({
      cancelled: true,
    });
    expect((await bookings()).map((b) => b.kind)).toEqual(["build"]);
  });
});

describe("job_capacity.reserve_lighthouse", () => {
  it("books a batch's width out of the check's share, and only its own check releases it", async () => {
    await budget(20);
    const audit = crypto.randomUUID();
    await book(audit, {
      kind: "quality_audit",
      cls: "immediate",
      vcpuPerTask: 1,
      auditReserve: true,
    });
    await index(crypto.randomUUID());
    const r = await op<{ bookingId: string; tasks: number }>("job_capacity.reserve_lighthouse", {
      subjectId: audit,
      attempt: 1,
      wanted: 15,
      leaseSeconds: 900,
    });
    expect(r.tasks).toBe(5);
    // The share is in use now, not on top of it.
    expect((await bookings()).find((b) => b.kind === "quality_audit")?.vcpu).toBe(11);
    expect(
      await op("job_capacity.release", {
        bookingId: r.bookingId,
        kind: "quality_audit",
        subjectId: crypto.randomUUID(),
      }),
    ).toEqual({ released: false });
    expect(
      await op("job_capacity.release", {
        bookingId: r.bookingId,
        kind: "quality_audit",
        subjectId: audit,
      }),
    ).toEqual({ released: true });
  });
});

describe("job_pieces", () => {
  const scope = "p/pages";
  const claim = (s: string, worker: string, helperId: string | null = null) =>
    op<Record<string, unknown>>("job_pieces.claim", {
      kind: "collection_index",
      subjectId: s,
      scope,
      worker,
      helperId,
      claimSeconds: 60,
      leaseSeconds: 600,
    });

  it("hands every piece out once, says wait while others hold the rest, none when all are done", async () => {
    await budget(20);
    const s = crypto.randomUUID();
    await index(s);
    await op("job_pieces.register", {
      kind: "collection_index",
      subjectId: s,
      scope,
      count: 3,
      done: [1],
      wantedTasks: 2,
      resetClaims: true,
    });
    const got = await Promise.all([claim(s, "lead"), claim(s, "lead")]);
    expect(got.map((g) => g.piece).sort()).toEqual([0, 2]);
    expect(await claim(s, "lead")).toEqual({ wait: true });
    // A claim that ran out is open again.
    await asSystem(
      (tx) =>
        tx`UPDATE job_pieces SET claim_until = now() - interval '1 second' WHERE piece = 0 AND subject_id = ${s}::uuid`,
    );
    expect(await claim(s, "lead")).toMatchObject({ piece: 0 });
    for (const piece of [0, 2])
      await op("job_pieces.done", { kind: "collection_index", subjectId: s, scope, piece });
    expect(await claim(s, "lead")).toEqual({ none: true });
    expect(await op("job_pieces.open_scopes", { kind: "collection_index", subjectId: s })).toEqual({
      scopes: [],
    });
  });

  it("a new lead's registration opens the claims of the attempt before", async () => {
    await budget(20);
    const s = crypto.randomUUID();
    await index(s);
    const register = () =>
      op("job_pieces.register", {
        kind: "collection_index",
        subjectId: s,
        scope,
        count: 2,
        done: [],
        wantedTasks: 1,
        resetClaims: true,
      });
    await register();
    await claim(s, "lead");
    await claim(s, "lead");
    expect(await claim(s, "lead")).toEqual({ wait: true });
    await register();
    expect(await claim(s, "lead")).toMatchObject({ piece: 0 });
  });

  it("a helper over its work's grant hears stop after its piece, and its task comes back", async () => {
    await budget(20);
    const s = crypto.randomUUID();
    await index(s);
    await runningAttempt("collection_index", s);
    await op("job_pieces.register", {
      kind: "collection_index",
      subjectId: s,
      scope,
      count: 40,
      done: [],
      wantedTasks: 32,
      resetClaims: true,
    });
    const { helpers } = await op<{ helpers: { bookingId: string }[] }>("job_capacity.admit", {});
    const helperId = (helpers[0] as { bookingId: string }).bookingId;
    expect(await claim(s, `${helperId}:0`, helperId)).toMatchObject({ piece: 0 });
    // The next Stage's quality check starts: its share is wanted now.
    await book(crypto.randomUUID(), {
      kind: "quality_audit",
      cls: "immediate",
      vcpuPerTask: 1,
      auditReserve: true,
    });
    expect(await claim(s, `${helperId}:1`, helperId)).toEqual({ stop: true });
    expect((await bookings()).find((b) => b.subjectId === s)?.tasks).toBe(5);
  });
});

describe("job_capacity.sweep", () => {
  it("gives back helpers and captures whose lease passed, and leads whose work no longer runs", async () => {
    await budget(20);
    await book(crypto.randomUUID(), {
      kind: "capture",
      role: "capture",
      cls: "immediate",
      vcpuPerTask: 1,
      leaseSeconds: 60,
    });
    const lost = crypto.randomUUID();
    await book(lost, { kind: "build", cls: "immediate", vcpuPerTask: 1 });
    const alive = crypto.randomUUID();
    await runningAttempt("build", alive);
    await book(alive, { kind: "build", cls: "immediate", vcpuPerTask: 1 });
    await asSystem(async (tx) => {
      await tx`UPDATE job_capacity_bookings SET lease_until = now() - interval '1 second' WHERE role = 'capture'`;
      await tx`UPDATE job_capacity_bookings SET started_at = now() - interval '16 minutes' WHERE role = 'lead'`;
    });
    expect(await op("job_capacity.sweep", { limit: 100 })).toEqual({ released: 2 });
    expect((await bookings()).map((b) => b.subjectId)).toEqual([alive]);
  });
});

describe("row-level security", () => {
  it("people and the AI read what runs; only the system writes", async () => {
    await budget(20);
    await book(crypto.randomUUID(), { kind: "build", cls: "immediate", vcpuPerTask: 1 });
    const read = await op<{ budget: { budgetVcpu: number } | null; bookings: unknown[] }>(
      "job_capacity.list",
      {},
      HUMAN,
    );
    expect(read.budget?.budgetVcpu).toBe(14);
    expect(read.bookings).toHaveLength(1);
    const r = await execute(registry, adapter, HUMAN, "job_capacity.admit", {});
    expect(r.ok).toBe(false);
    const sql = new SQL(ADMIN_URL as string);
    try {
      const deleted = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'human'");
        return tx`DELETE FROM job_capacity_bookings RETURNING id`;
      });
      expect(deleted).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });
});
