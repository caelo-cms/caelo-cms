// SPDX-License-Identifier: MPL-2.0

/**
 * #1328 — a Hosting version cloned from an existing one must send `/api/**`
 * to the gateway the admin's env names now, not the one of its day.
 */

import { describe, expect, it } from "bun:test";
import {
  currentGatewayRewrite,
  hasCurrentGatewayRewrite,
  withCurrentGatewayRewrite,
} from "../firebase-gateway-rewrite.js";

const ENV = {
  CAELO_GATEWAY_SERVICE: "caelo-production-data-gateway",
  CAELO_GATEWAY_REGION: "europe-west1",
};
const CURRENT = {
  glob: "/api/**",
  run: { serviceId: "caelo-production-data-gateway", region: "europe-west1" },
};
const OLD = {
  glob: "/api/**",
  run: { serviceId: "caelo-production-gateway-1a2b3c", region: "europe-west1" },
};

describe("withCurrentGatewayRewrite", () => {
  it("replaces an old serviceId in place and keeps every other field and rewrite", () => {
    const other = { glob: "/app/**", destination: "/app/index.html" };
    const config = {
      headers: [{ glob: "**", headers: { "X-Content-Type-Options": "nosniff" } }],
      redirects: [{ regex: "^/old/?$", location: "/new/", statusCode: 301 }],
      rewrites: [other, OLD],
      cleanUrls: true,
    };
    expect(withCurrentGatewayRewrite(config, ENV)).toEqual({
      ...config,
      rewrites: [other, CURRENT],
    });
  });

  it("adds the rewrite first to a config without one", () => {
    expect(withCurrentGatewayRewrite({}, ENV)).toEqual({ rewrites: [CURRENT] });
  });

  it("drops a second, dead gateway rewrite", () => {
    expect(withCurrentGatewayRewrite({ rewrites: [OLD, OLD] }, ENV).rewrites).toEqual([CURRENT]);
  });

  it("is idempotent", () => {
    const once = withCurrentGatewayRewrite({ rewrites: [OLD] }, ENV);
    expect(withCurrentGatewayRewrite(once, ENV)).toEqual(once);
  });

  it("fails loudly without the gateway env (no fallback)", () => {
    expect(() => withCurrentGatewayRewrite({ rewrites: [OLD] }, {})).toThrow(
      /CAELO_GATEWAY_SERVICE \/ CAELO_GATEWAY_REGION not set/,
    );
    expect(() => currentGatewayRewrite({ CAELO_GATEWAY_SERVICE: "x" })).toThrow(/not set/);
  });
});

describe("hasCurrentGatewayRewrite", () => {
  it("is true only for exactly one rewrite naming the current service and region", () => {
    expect(hasCurrentGatewayRewrite({ rewrites: [CURRENT] }, ENV)).toBe(true);
    expect(hasCurrentGatewayRewrite({ rewrites: [OLD] }, ENV)).toBe(false);
    expect(hasCurrentGatewayRewrite({ rewrites: [CURRENT, CURRENT] }, ENV)).toBe(false);
    expect(
      hasCurrentGatewayRewrite(
        { rewrites: [{ ...CURRENT, run: { ...CURRENT.run, region: "us-central1" } }] },
        ENV,
      ),
    ).toBe(false);
    expect(hasCurrentGatewayRewrite({}, ENV)).toBe(false);
  });
});
