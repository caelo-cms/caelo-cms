// SPDX-License-Identifier: MPL-2.0

/** #1595 — what the incident report says about the database's sessions. */

import { describe, expect, it } from "bun:test";
import {
  type ActivitySession,
  diagnose,
  EVIDENCE_MAX_CHARS,
  renderIncidentEvidence,
  sanitizeStatement,
} from "./evidence.js";

const session = (over: Partial<ActivitySession>): ActivitySession => ({
  pid: 1,
  database: "cms_admin",
  role: "admin_role",
  state: "active",
  waitEventType: null,
  waitEvent: null,
  xactMs: 1_000,
  queryMs: 1_000,
  stateMs: 1_000,
  blockedBy: [],
  statement: "SELECT 1",
  ...over,
});

const activity = (sessions: ActivitySession[]) => ({
  takenAt: "2026-11-11T11:45:58Z",
  deadlocks: 0,
  sessions,
});

describe("sanitizeStatement", () => {
  it("replaces every literal and keeps the statement's shape", () => {
    expect(
      sanitizeStatement(
        "SELECT * FROM users WHERE email = 'owner@example.com'  AND note = E'it''s' AND x = $$secret$$",
      ),
    ).toBe("SELECT * FROM users WHERE email = '?' AND note = '?' AND x = '?'");
    expect(sanitizeStatement("SELECT $tag$ body $tag$")).toBe("SELECT '?'");
  });

  it("hides what the role may not read", () => {
    expect(sanitizeStatement("<insufficient privilege>")).toBeNull();
    expect(sanitizeStatement("   ")).toBeNull();
    expect(sanitizeStatement(null)).toBeNull();
  });

  it("cuts a long statement to one line", () => {
    expect(sanitizeStatement(`SELECT\n${"a, ".repeat(400)}b`)?.length).toBe(240);
  });
});

describe("diagnose", () => {
  it("names a lock queue and the session it starts at", () => {
    const out = diagnose(
      activity([
        session({ pid: 7, state: "idle in transaction", stateMs: 58_000, xactMs: 70_000 }),
        session({ pid: 8, waitEventType: "Lock", waitEvent: "tuple", blockedBy: [9] }),
        session({ pid: 9, waitEventType: "Lock", waitEvent: "transactionid", blockedBy: [7] }),
      ]),
    );
    expect(out[0]).toBe(
      "Lock queue: 2 session(s) wait for locks another session holds; the queue starts at pid 7 (idle in transaction, transaction open 70 s).",
    );
    expect(out[1]).toContain("1 transaction(s) sit idle while open (longest 58 s)");
  });

  it("calls statements that wait on nothing CPU-bound", () => {
    const out = diagnose(
      activity([
        session({ pid: 1, queryMs: 40_000 }),
        session({ pid: 2, queryMs: 2_000 }),
        session({ pid: 3, state: "idle" }),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(
      "2 statement(s) run without waiting on anything (on the CPU), 1 of them for 5 s or more",
    );
  });

  it("says when the database shows nothing and the pool holders are the lead", () => {
    expect(diagnose(activity([session({ state: "idle" })]))[0]).toContain(
      "the admin's own pool holders (above) held the connections",
    );
  });
});

describe("renderIncidentEvidence", () => {
  it("stays inside the evidence column", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      session({ pid: i, statement: `SELECT ${"x".repeat(200)}`, blockedBy: i > 0 ? [0] : [] }),
    );
    const text = renderIncidentEvidence({
      instance: "rev",
      version: "0.12.5",
      openedAt: 0,
      lastSignalAt: 300_000,
      firstSign: "statement_timeout",
      counts: new Map([["statement_timeout", 40]]),
      failingHolders: [],
      peak: null,
      builds: [],
      snapshots: [
        {
          pressure: {
            pool: "admin",
            max: 10,
            inUse: 10,
            waiting: 3,
            oldestWaitMs: 9_000,
            holders: [],
          },
          activity: activity(many),
        },
      ],
      snapshotError: null,
    });
    expect(text.length).toBeLessThanOrEqual(EVIDENCE_MAX_CHARS);
    expect(text).toContain("First sign: statements ran past the statement timeout");
    expect(text).toContain("Lock queue: 199 session(s)");
  });

  it("says why a snapshot is missing", () => {
    const text = renderIncidentEvidence({
      instance: "rev",
      version: "0.12.5",
      openedAt: 0,
      lastSignalAt: 1_000,
      firstSign: "pool_wait_timeout",
      counts: new Map([["pool_wait_timeout", 1]]),
      failingHolders: [],
      peak: null,
      builds: [],
      snapshots: [],
      snapshotError: "the snapshot failed: no free connection",
    });
    expect(text).toContain("## No database snapshot: the snapshot failed: no free connection");
  });
});
