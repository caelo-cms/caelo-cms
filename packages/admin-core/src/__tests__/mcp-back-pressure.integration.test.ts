// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1375 — MCP back-pressure against a real Postgres: N parallel
 * sessions hold and queue for a small admin pool, and the MCP gate answers
 * 429 + Retry-After while callers wait, then lets calls through again once
 * the pool drained. A call whose own checkout ran into the pool deadline is
 * answered the same way, never as a 500 or a defect.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { mcpBackPressureResponse, mcpBusyFailureResponse } from "../mcp-back-pressure.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const POOL = 3;
const SESSIONS = 8;
const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1375-back-pressure",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

beforeAll(async () => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_URL,
    poolMax: POOL,
    poolAcquireTimeoutMs: 4_000,
  });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await adapter.verifyRoles();
});

afterAll(async () => {
  await adapter.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("#1375 — MCP back-pressure on a saturated admin pool", () => {
  it("N parallel sessions saturate the pool: MCP gets 429 while they queue, then passes", async () => {
    expect(mcpBackPressureResponse("/api/mcp/tool", adapter.poolPressure("admin"))).toBeNull();

    // Each session's call holds its connection for 1.5 s, as a slow read did.
    const sessions = Array.from({ length: SESSIONS }, (_, i) =>
      adapter.withAdminTransaction(
        ctx,
        async (tx) => {
          await tx.execute(sql`SELECT pg_sleep(1.5)`);
          return i;
        },
        { holder: `t1375.session-${i}` },
      ),
    );
    await sleep(1_200);

    const pressure = adapter.poolPressure("admin");
    expect(pressure.max).toBe(POOL);
    expect(pressure.inUse).toBe(POOL);
    expect(pressure.waiting).toBe(SESSIONS - POOL);
    expect(pressure.oldestWaitMs).toBeGreaterThanOrEqual(1_000);
    // The holders are named, longest first: the log says who kept the pool.
    expect(pressure.holders).toHaveLength(POOL);
    for (const h of pressure.holders) expect(h.holder).toStartWith("t1375.session-");

    const refused = mcpBackPressureResponse("/api/mcp/remote/admin", pressure);
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThanOrEqual(5);
    // The editor's own requests are not refused.
    expect(mcpBackPressureResponse("/edit", pressure)).toBeNull();

    // Every queued session is served once the holders finish (the gate
    // refused only new MCP calls; nothing already waiting was dropped).
    expect((await Promise.all(sessions)).sort()).toEqual([...Array(SESSIONS).keys()]);
    const drained = adapter.poolPressure("admin");
    expect(drained.inUse).toBe(0);
    expect(drained.waiting).toBe(0);
    expect(mcpBackPressureResponse("/api/mcp/tool", drained)).toBeNull();
  }, 30_000);

  it("workers' raw transactions count too: waiting, then held as raw.begin", async () => {
    const raw = Array.from({ length: POOL + 2 }, () =>
      adapter.rawAdmin().begin(async (tx) => {
        await tx`SELECT pg_sleep(1.5)`;
      }),
    );
    await sleep(1_200);
    const pressure = adapter.poolPressure("admin");
    expect(pressure.inUse).toBe(POOL);
    expect(pressure.waiting).toBe(2);
    for (const h of pressure.holders) expect(h.holder).toBe("raw.begin");
    expect(mcpBackPressureResponse("/api/mcp/tool", pressure)?.status).toBe(429);
    await Promise.all(raw);
    expect(adapter.poolPressure("admin")).toMatchObject({ inUse: 0, waiting: 0 });
  }, 30_000);

  it("a call that hit the pool deadline is answered 429 with Retry-After, not 500", async () => {
    const held = await Promise.all(
      Array.from({ length: POOL }, () => adapter.rawAdmin().reserve()),
    );
    try {
      const r = await execute(registry, adapter, ctx, "site_defaults.get", {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe("HandlerError");
      if (r.error.kind !== "HandlerError") return;
      // Load, not a defect: no bug report, and a retry hint.
      expect(r.error.internal).toBeUndefined();
      expect(r.error.busy?.retryAfterMs).toBe(5_000);
      expect(r.error.message).toContain("send the same call again unchanged");
      const res = mcpBusyFailureResponse(r.error, "/api/mcp/tool");
      expect(res?.status).toBe(429);
      expect(res?.headers.get("retry-after")).toBe("5");
    } finally {
      for (const c of held) c.release();
    }
    const again = await execute(registry, adapter, ctx, "site_defaults.get", {});
    expect(again.ok).toBe(true);
  }, 30_000);
});
