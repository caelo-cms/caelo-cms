// SPDX-License-Identifier: MPL-2.0

/**
 * #1595 — an admin stall files one bug report that names who blocks whom.
 * Real Postgres (§6):
 *   - `diagnostics.database_activity` shows a blocked session and the
 *     session holding its lock, with statement text but no literal;
 *   - the adapter hands a statement timeout to its trouble listeners with
 *     the transaction holder that met it;
 *   - the installed capture files the report with a database snapshot;
 *   - `ai_bug_reports.update_incident` touches only automatic reports and
 *     only the system may call it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  DatabaseAdapter,
  type DatabaseTrouble,
  execute,
  OperationRegistry,
} from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import type { DatabaseActivity } from "../incident/evidence.js";
import { installIncidentCapture } from "../incident/install.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "incident-capture-test",
};
const AI: ExecutionContext = { ...SYSTEM, actorKind: "ai" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

/** Poll `probe` until it returns a value, or fail after `ms`. */
async function eventually<T>(probe: () => Promise<T | null>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== null) return found;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(50);
  }
}

/** A transaction that fails on its own statement timeout. */
async function timeOut(holder: string): Promise<void> {
  await adapter
    .withAdminTransaction(
      SYSTEM,
      async (tx) => {
        await tx.execute(sql`SELECT set_config('statement_timeout', '100ms', true)`);
        await tx.execute(sql`SELECT pg_sleep(2)`);
      },
      { holder },
    )
    .then(
      () => {
        throw new Error("expected the statement to time out");
      },
      () => undefined,
    );
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

beforeEach(async () => {
  await adapter.withAdminTransaction(SYSTEM, async (tx) => {
    await tx.execute(sql`DELETE FROM ai_bug_reports`);
  });
});

describe("diagnostics.database_activity", () => {
  it("shows a blocked session, the session that holds its lock, and no literal", async () => {
    const key = 915_951;
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => {
      locked = r;
    });
    const holder = adapter.withAdminTransaction(
      SYSTEM,
      async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${key}), 'secret-literal' AS marker`);
        locked();
        await released;
      },
      { holder: "test.lock-holder" },
    );
    await lockTaken;
    const waiter = adapter.withAdminTransaction(
      SYSTEM,
      async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${key})`);
      },
      { holder: "test.lock-waiter" },
    );
    try {
      const activity = await eventually(async () => {
        const r = await execute(registry, adapter, SYSTEM, "diagnostics.database_activity", {});
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        const value = r.value as DatabaseActivity;
        return value.sessions.some((s) => s.blockedBy.length > 0) ? value : null;
      });
      const blocked = activity.sessions.find((s) => s.blockedBy.length > 0);
      const blocker = activity.sessions.find((s) => s.pid === blocked?.blockedBy[0]);
      expect(blocked?.waitEventType).toBe("Lock");
      expect(blocked?.statement).toContain("pg_advisory_xact_lock($1)");
      expect(blocker?.state).toBe("idle in transaction");
      expect(blocker?.statement).toContain("'?' AS marker");
      expect(JSON.stringify(activity)).not.toContain("secret-literal");
    } finally {
      release();
      await holder;
      await waiter;
    }
  });

  it("is the system's alone", async () => {
    const r = await execute(registry, adapter, AI, "diagnostics.database_activity", {});
    expect(r.ok).toBe(false);
  });
});

describe("database trouble", () => {
  it("reaches the adapter's listeners with the holder that met it", async () => {
    const seen: DatabaseTrouble[] = [];
    const off = adapter.onDatabaseTrouble((t) => seen.push(t));
    try {
      await timeOut("test.slow-read");
    } finally {
      off();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "statement_timeout",
      pool: "admin",
      holder: "test.slow-read",
    });
  });
});

describe("the incident capture", () => {
  it("files one report with the database's session list", async () => {
    const { uninstall } = installIncidentCapture({ adapter, registry, instance: "test-instance" });
    try {
      await timeOut("test.incident-read");
      const report = await eventually(async () => {
        const r = await execute(registry, adapter, SYSTEM, "ai_bug_reports.list", {});
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        const rows = (
          r.value as { reports: { title: string; evidence: string | null; source: string }[] }
        ).reports;
        const row = rows.find((x) => x.title === "Admin stalled: database calls timed out");
        return row?.evidence?.includes("## Snapshot") ? row : null;
      });
      expect(report.source).toBe("auto");
      expect(report.evidence).toContain("Instance test-instance");
      expect(report.evidence).toContain("test.incident-read: 1× statement_timeout");
      expect(report.evidence).toContain("Database sessions (every instance):");
      expect(report.evidence).toContain("Diagnosis:");
    } finally {
      uninstall();
    }
  });
});

describe("ai_bug_reports.update_incident", () => {
  it("rewrites only an automatic report, and only for the system", async () => {
    const created = await execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
      kind: "defect",
      title: "A tool misbehaved",
      whatHappened: "x",
      expected: "y",
      source: "ai",
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const reportId = (created.value as { id: string }).id;
    const input = { reportId, evidence: "rewritten", severity: "blocking", blockedTask: true };
    const bySystem = await execute(
      registry,
      adapter,
      SYSTEM,
      "ai_bug_reports.update_incident",
      input,
    );
    expect(bySystem.ok && (bySystem.value as { updated: boolean }).updated).toBe(false);
    const byAi = await execute(registry, adapter, AI, "ai_bug_reports.update_incident", input);
    expect(byAi.ok).toBe(false);
  });
});
