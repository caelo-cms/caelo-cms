// SPDX-License-Identifier: MPL-2.0

/**
 * #1595 — one report per incident, written as it grows; MCP refusals alone
 * only once they last; the capture's own failures are no signals.
 */

import { describe, expect, it } from "bun:test";
import type { DatabaseTrouble, PoolPressure } from "@caelo-cms/query-api";
import {
  INCIDENT_CAPTURE_OPERATIONS,
  INCIDENT_QUIET_MS,
  IncidentCapture,
  type IncidentReportDraft,
  SUSTAINED_REFUSAL_MS,
} from "./capture.js";
import type { DatabaseActivity } from "./evidence.js";

const FULL: PoolPressure = {
  pool: "admin",
  max: 10,
  inUse: 10,
  waiting: 2,
  oldestWaitMs: 9_900,
  holders: [{ holder: "mcp.begin_tool_call", heldMs: 75_000 }],
};

const ACTIVITY: DatabaseActivity = {
  takenAt: "2026-11-11T11:45:58Z",
  deadlocks: 0,
  sessions: [
    {
      pid: 1,
      database: "cms_admin",
      role: "admin_role",
      state: "idle in transaction",
      waitEventType: "Client",
      waitEvent: "ClientRead",
      xactMs: 70_000,
      queryMs: 58_000,
      stateMs: 58_000,
      blockedBy: [],
      statement: "SELECT id FROM public_projection_outbox ORDER BY id LIMIT $1",
    },
    {
      pid: 2,
      database: "cms_admin",
      role: "admin_role",
      state: "active",
      waitEventType: "Lock",
      waitEvent: "transactionid",
      xactMs: 14_000,
      queryMs: 14_000,
      stateMs: 14_000,
      blockedBy: [1],
      statement: "UPDATE plugin_runtime SET heartbeat_at = now() WHERE instance_id = $1",
    },
  ],
};

const trouble = (holder: string, kind: DatabaseTrouble["kind"] = "statement_timeout") => ({
  kind: "database" as const,
  trouble: { kind, pool: "admin" as const, holder, elapsedMs: 60_000 },
});

function harness(opts: { failFile?: number } = {}) {
  let now = 1_000_000;
  let pressure: PoolPressure = { ...FULL, waiting: 0, inUse: 4 };
  const filed: IncidentReportDraft[] = [];
  const updates: { id: string; draft: IncidentReportDraft }[] = [];
  let snapshots = 0;
  let failFile = opts.failFile ?? 0;
  const pending: Promise<void>[] = [];
  const capture = new IncidentCapture({
    now: () => now,
    pressure: () => pressure,
    snapshot: async () => {
      snapshots += 1;
      return ACTIVITY;
    },
    file: async (draft) => {
      if (failFile > 0) {
        failFile -= 1;
        throw new Error("the admin database pool had no free connection");
      }
      filed.push(draft);
      return `report-${filed.length}`;
    },
    update: async (id, draft) => {
      updates.push({ id, draft });
    },
    detach: (work) => {
      pending.push(Promise.resolve().then(work));
    },
    instance: "rev-1",
    version: "0.12.5",
  });
  /** Let every started write finish (they chain through microtasks). */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await Promise.all(pending);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    capture,
    filed,
    updates,
    settle,
    snapshots: () => snapshots,
    advance: (ms: number) => {
      now += ms;
    },
    setPressure: (p: PoolPressure) => {
      pressure = p;
    },
  };
}

describe("IncidentCapture", () => {
  it("files one report for a burst of database trouble and rewrites it as the incident grows", async () => {
    const h = harness();
    h.setPressure(FULL);
    h.capture.note(trouble("modules.list"));
    await h.settle();
    expect(h.filed).toHaveLength(1);
    const first = h.filed[0];
    expect(first?.title).toBe("Admin stalled: database calls timed out");
    expect(first?.severity).toBe("degraded");
    expect(first?.evidence).toContain("modules.list: 1× statement_timeout");
    expect(first?.evidence).toContain("10/10 in use, 2 waiting");
    // The snapshot names the lock queue and where it starts.
    expect(first?.evidence).toContain("Lock queue: 1 session(s)");
    expect(first?.evidence).toContain("the queue starts at pid 1 (idle in transaction");

    for (let i = 0; i < 30; i++) {
      h.advance(5_000);
      h.capture.note(
        trouble(i % 2 === 0 ? "plugin_changes.claim" : "modules.list", "lock_timeout"),
      );
    }
    await h.settle();
    expect(h.filed).toHaveLength(1);
    expect(h.updates.length).toBeGreaterThan(0);
    const last = h.updates[h.updates.length - 1];
    expect(last?.id).toBe("report-1");
    expect(last?.draft.evidence).toContain("30× lock waits ran past the lock timeout");
    // whatHappened stays the same, so the intake's fingerprint merges repeats.
    expect(last?.draft.whatHappened).toBe(first?.whatHappened ?? "");
  });

  it("reports MCP refusals alone only once they have lasted", async () => {
    const h = harness();
    h.capture.note({ kind: "mcp_refused" });
    h.advance(SUSTAINED_REFUSAL_MS - 1_000);
    h.capture.note({ kind: "mcp_refused" });
    await h.settle();
    expect(h.filed).toHaveLength(0);
    h.advance(2_000);
    h.capture.note({ kind: "mcp_refused" });
    await h.settle();
    expect(h.filed).toHaveLength(1);
    expect(h.filed[0]?.evidence).toContain("3× MCP calls were refused");
  });

  it("does not count the capture's own operations as signals", async () => {
    const h = harness();
    for (const op of INCIDENT_CAPTURE_OPERATIONS) h.capture.note(trouble(op, "pool_wait_timeout"));
    await h.settle();
    expect(h.filed).toHaveLength(0);
  });

  it("keeps a failed build only as evidence of an open incident, and then blocks", async () => {
    const h = harness();
    const build = {
      kind: "build_failed" as const,
      build: {
        kind: "stage",
        runId: "d9f229a4",
        totalMs: 169_325,
        message: "publishing it failed (terminating connection due to idle-in-transaction timeout)",
        phases: [
          { phase: "generator", ms: 27_994 },
          { phase: "publish", ms: 5_548 },
        ],
      },
    };
    h.capture.note(build);
    await h.settle();
    expect(h.filed).toHaveLength(0);

    h.capture.note(trouble("withAdminTransaction", "idle_in_transaction_timeout"));
    h.capture.note(build);
    await h.settle();
    const latest = h.updates[h.updates.length - 1]?.draft ?? h.filed[0];
    expect(latest?.severity).toBe("blocking");
    expect(latest?.blockedTask).toBe(true);
    expect(latest?.evidence).toContain("## stage d9f229a4 failed after 169 s");
    expect(latest?.evidence).toContain("Slowest phases: generator 28 s, publish 5.5 s.");
  });

  it("opens a new incident after a quiet stretch", async () => {
    const h = harness();
    h.capture.note(trouble("modules.list"));
    await h.settle();
    h.advance(INCIDENT_QUIET_MS + 1);
    h.capture.note(trouble("pages.list"));
    await h.settle();
    expect(h.filed).toHaveLength(2);
    expect(h.filed[1]?.evidence).not.toContain("modules.list");
  });

  it("retries a write that failed only on the next signal", async () => {
    const h = harness({ failFile: 1 });
    h.capture.note(trouble("modules.list"));
    await h.settle();
    expect(h.filed).toHaveLength(0);
    h.advance(1_000);
    h.capture.note(trouble("modules.list"));
    await h.settle();
    expect(h.filed).toHaveLength(1);
    expect(h.filed[0]?.evidence).toContain("modules.list: 2× statement_timeout");
  });

  it("takes a second snapshot only when the pool got fuller", async () => {
    const h = harness();
    h.setPressure({ ...FULL, waiting: 1 });
    h.capture.note(trouble("a"));
    await h.settle();
    h.capture.note(trouble("b"));
    await h.settle();
    expect(h.snapshots()).toBe(1);
    h.setPressure({ ...FULL, waiting: 5 });
    h.capture.note(trouble("c"));
    await h.settle();
    expect(h.snapshots()).toBe(2);
    h.setPressure({ ...FULL, waiting: 9 });
    h.capture.note(trouble("d"));
    await h.settle();
    expect(h.snapshots()).toBe(2);
  });
});
