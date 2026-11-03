// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PoolPressure } from "@caelo-cms/query-api";
import {
  MCP_MAX_RETRY_AFTER_SECONDS,
  mcpBackPressure,
  mcpBackPressureResponse,
} from "./mcp-back-pressure.js";

function pressure(over: Partial<PoolPressure>): PoolPressure {
  return {
    pool: "admin",
    max: 10,
    inUse: 10,
    waiting: 0,
    oldestWaitMs: 0,
    holders: [],
    ...over,
  };
}

describe("#1375 — MCP back-pressure decision", () => {
  it("lets every call through while nobody waits, even with every connection in use", () => {
    expect(mcpBackPressure(pressure({ inUse: 10, waiting: 0 }))).toEqual({ busy: false });
  });

  it("lets a short burst through: waiters served within a second are normal", () => {
    expect(mcpBackPressure(pressure({ waiting: 3, oldestWaitMs: 400 }))).toEqual({ busy: false });
  });

  it("refuses once the oldest waiter has waited a second, asking for at least 5 s", () => {
    expect(mcpBackPressure(pressure({ waiting: 1, oldestWaitMs: 1_000 }))).toEqual({
      busy: true,
      retryAfterSeconds: 5,
    });
  });

  it("refuses at once when as many callers wait as the pool has connections", () => {
    expect(mcpBackPressure(pressure({ max: 4, waiting: 4, oldestWaitMs: 50 }))).toEqual({
      busy: true,
      retryAfterSeconds: 5,
    });
  });

  it("asks for a longer wait the longer the queue has stood still, capped", () => {
    expect(mcpBackPressure(pressure({ waiting: 2, oldestWaitMs: 12_300 }))).toEqual({
      busy: true,
      retryAfterSeconds: 13,
    });
    expect(mcpBackPressure(pressure({ waiting: 2, oldestWaitMs: 600_000 }))).toEqual({
      busy: true,
      retryAfterSeconds: MCP_MAX_RETRY_AFTER_SECONDS,
    });
  });
});

describe("#1375 — the MCP gate's response", () => {
  const saturated = pressure({ waiting: 5, oldestWaitMs: 3_000 });

  it("touches only /api/mcp/*: the editor's own requests keep queueing", () => {
    expect(mcpBackPressureResponse("/edit", saturated)).toBeNull();
    expect(mcpBackPressureResponse("/api/chat/stream", saturated)).toBeNull();
  });

  it("answers the bridge endpoints with 429, Retry-After and a message for the agent", async () => {
    const r = mcpBackPressureResponse("/api/mcp/tool", saturated);
    expect(r?.status).toBe(429);
    expect(r?.headers.get("retry-after")).toBe("5");
    const body = (await r?.json()) as { message: string; retryAfterSeconds: number };
    expect(body.retryAfterSeconds).toBe(5);
    expect(body.message).toContain("this call was not run");
    expect(body.message).toContain("Wait 5 s, then send the same call again unchanged");
  });

  it("answers the remote endpoints with a JSON-RPC error the client shows", async () => {
    const r = mcpBackPressureResponse("/api/mcp/remote/admin", saturated);
    expect(r?.status).toBe(429);
    expect(r?.headers.get("retry-after")).toBe("5");
    const body = (await r?.json()) as {
      jsonrpc: string;
      error: { code: number; message: string; data: { retryAfterSeconds: number } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32000);
    expect(body.error.data.retryAfterSeconds).toBe(5);
    expect(body.error.message).toContain("at capacity");
  });

  it("lets MCP through while the pool keeps up", () => {
    expect(mcpBackPressureResponse("/api/mcp/tool", pressure({ waiting: 0 }))).toBeNull();
  });
});
