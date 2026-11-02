// SPDX-License-Identifier: MPL-2.0

/**
 * #806 follow-up — remote-MCP routes are throttled per client address
 * before any work (config load, CIMD fetch, Google call, admin proxy).
 */

import { describe, expect, it } from "bun:test";
import { CLAUDE_REDIRECT, harness, postToken, registerClient } from "./__tests__/harness.js";
import { MCP_RATE_LIMITS, McpRateLimiter } from "./rate-limit.js";

describe("McpRateLimiter", () => {
  it("allows the capacity, refuses the next with a Retry-After, and refills over the window", () => {
    let now = 0;
    const l = new McpRateLimiter(() => now);
    const { capacity, windowSeconds } = MCP_RATE_LIMITS.register;
    for (let i = 0; i < capacity; i++) expect(l.take("register", "a").ok).toBe(true);
    const refused = l.take("register", "a");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
    }
    // Other addresses and other classes have their own buckets.
    expect(l.take("register", "b").ok).toBe(true);
    expect(l.take("token", "a").ok).toBe(true);
    now += (windowSeconds * 1000) / capacity;
    expect(l.take("register", "a").ok).toBe(true);
    expect(l.take("register", "a").ok).toBe(false);
  });
});

const TINY = {
  authorize: { capacity: 3, windowSeconds: 60 },
  callback: { capacity: 3, windowSeconds: 60 },
  token: { capacity: 3, windowSeconds: 60 },
  register: { capacity: 3, windowSeconds: 60 },
  metadata: { capacity: 3, windowSeconds: 60 },
  proxy: { capacity: 3, windowSeconds: 60 },
};

describe("router throttling", () => {
  it.each([
    ["/api/mcp/oauth/register", { method: "POST", body: "{}" }],
    ["/api/mcp/oauth/token", { method: "POST" }],
    ["/api/mcp/oauth/authorize", {}],
    ["/api/mcp/oauth/authorize", { method: "POST" }],
    ["/api/mcp/oauth/google-callback", {}],
    ["/api/mcp/chat", { method: "POST" }],
    ["/.well-known/oauth-authorization-server/api/mcp/oauth", {}],
  ] as const)("answers 429 on the N+1st request to %s from one address", async (path, init) => {
    const h = harness({ rateLimits: TINY });
    for (let i = 0; i < 3; i++) {
      expect((await h.send(path, { ...init })).status).not.toBe(429);
    }
    const limited = await h.send(path, { ...init });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(((await limited.json()) as { error: string }).error).toBe("rate_limited");
    // Another address is unaffected.
    expect((await h.send(path, { ...init }, "203.0.113.9")).status).not.toBe(429);
  });

  it("refuses before calling Google", async () => {
    const h = harness({ rateLimits: TINY });
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    for (let i = 0; i < 3; i++) {
      await postToken(h, {
        grant_type: "refresh_token",
        refresh_token: "v2.x.y.z",
        client_id: clientId,
      });
    }
    const before = h.calls.length;
    const res = await postToken(h, {
      grant_type: "refresh_token",
      refresh_token: "v2.x.y.z",
      client_id: clientId,
    });
    expect(res.status).toBe(429);
    expect(h.calls).toHaveLength(before);
  });

  it("does not count CORS preflights", async () => {
    const h = harness({ rateLimits: TINY });
    for (let i = 0; i < 10; i++) {
      expect((await h.send("/api/mcp/oauth/token", { method: "OPTIONS" })).status).toBe(204);
    }
  });
});
