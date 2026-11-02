// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { CAELO_VERSION } from "@caelo-cms/shared";
import { GATEWAY_HEALTH_PATH, gatewayHealth } from "./health.js";
import { MemoryRateLimiter } from "./middleware/memory-limiter.js";
import { JSON_SECURITY_HEADERS } from "./middleware/security-headers.js";

const url = (query = "") => new URL(`https://example.com${GATEWAY_HEALTH_PATH}${query}`);
const healthy = { verifyRoles: async () => {} };
const broken = {
  verifyRoles: async () => {
    throw new Error("password authentication failed for user gateway_role at 10.0.0.3");
  },
};
const CLIENT = "198.51.100.7";
const roomy = () => new MemoryRateLimiter({ capacity: 100, refillPerSec: 1 });

describe("gatewayHealth", () => {
  it("answers liveness without the version and without touching the database (#1326)", async () => {
    const r = await gatewayHealth(url(), broken, null);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(text).not.toContain(CAELO_VERSION);
  });

  it("deep: 200 when the database login works, with the JSON security headers", async () => {
    const r = await gatewayHealth(url("?deep=1"), healthy, CLIENT, roomy());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    for (const [name, value] of Object.entries(JSON_SECURITY_HEADERS)) {
      expect(r.headers.get(name)).toBe(value);
    }
    expect(await r.json()).toEqual({ ok: true });
  });

  it("deep: 503 with only a failure kind — never the database error", async () => {
    const r = await gatewayHealth(url("?deep=1"), broken, CLIENT, roomy());
    expect(r.status).toBe(503);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { kind: "DbUnreachable" } });
    expect(text).not.toContain("gateway_role");
    expect(text).not.toContain("10.0.0.3");
  });

  it("deep: 503 before the gateway bootstrapped", async () => {
    const r = await gatewayHealth(url("?deep=1"), null, CLIENT, roomy());
    expect(r.status).toBe(503);
  });

  it("deep: throttled per client before the database round trip (#1326)", async () => {
    let calls = 0;
    const counting = { verifyRoles: async () => void calls++ };
    const limiter = new MemoryRateLimiter({ capacity: 2, refillPerSec: 0.01 });
    for (let i = 0; i < 2; i++) {
      expect((await gatewayHealth(url("?deep=1"), counting, CLIENT, limiter)).status).toBe(200);
    }
    const limited = await gatewayHealth(url("?deep=1"), counting, CLIENT, limiter);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(calls).toBe(2);
    // Another client has its own budget.
    expect((await gatewayHealth(url("?deep=1"), counting, "203.0.113.9", limiter)).status).toBe(
      200,
    );
    // An unknown client address is refused, never left unthrottled.
    expect((await gatewayHealth(url("?deep=1"), counting, null, limiter)).status).toBe(429);
  });
});
