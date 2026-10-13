// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { CAELO_VERSION } from "@caelo-cms/shared";
import { GATEWAY_HEALTH_PATH, gatewayHealth } from "./health.js";

const url = (query = "") => new URL(`https://example.com${GATEWAY_HEALTH_PATH}${query}`);
const healthy = { verifyRoles: async () => {} };
const broken = {
  verifyRoles: async () => {
    throw new Error("password authentication failed for user gateway_role at 10.0.0.3");
  },
};

describe("gatewayHealth", () => {
  it("answers liveness with the version, without touching the database", async () => {
    const r = await gatewayHealth(url(), broken);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: CAELO_VERSION });
  });

  it("deep: 200 when both database logins work", async () => {
    const r = await gatewayHealth(url("?deep=1"), healthy);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ ok: true, version: CAELO_VERSION });
  });

  it("deep: 503 with only a failure kind — never the database error", async () => {
    const r = await gatewayHealth(url("?deep=1"), broken);
    expect(r.status).toBe(503);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      version: CAELO_VERSION,
      error: { kind: "DbUnreachable" },
    });
    expect(text).not.toContain("gateway_role");
    expect(text).not.toContain("10.0.0.3");
  });

  it("deep: 503 before the gateway bootstrapped", async () => {
    const r = await gatewayHealth(url("?deep=1"), null);
    expect(r.status).toBe(503);
  });
});
