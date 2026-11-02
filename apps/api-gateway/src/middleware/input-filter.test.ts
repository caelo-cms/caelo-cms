// SPDX-License-Identifier: MPL-2.0

/**
 * #1326 — the gateway's cheap checks before the database: the in-memory
 * limiter, the plugin route filter and the JSON security headers.
 */

import { describe, expect, it } from "bun:test";
import { MemoryRateLimiter } from "./memory-limiter.js";
import { parsePluginPath, refusePluginRequest } from "./plugin-request-filter.js";
import { JSON_SECURITY_HEADERS, withJsonSecurityHeaders } from "./security-headers.js";

describe("MemoryRateLimiter", () => {
  it("allows a burst of `capacity`, then refills at `refillPerSec`", () => {
    let now = 0;
    const l = new MemoryRateLimiter({ capacity: 3, refillPerSec: 1 }, 100, () => now);
    for (let i = 0; i < 3; i++) expect(l.take("a").allowed).toBe(true);
    const denied = l.take("a");
    expect(denied).toEqual({ allowed: false, retryAfterSec: 1 });
    expect(l.take("b").allowed).toBe(true);
    now = 1000;
    expect(l.take("a").allowed).toBe(true);
    expect(l.take("a").allowed).toBe(false);
  });

  it("stays within maxKeys, dropping refilled buckets first, then the least recently used", () => {
    let now = 0;
    const l = new MemoryRateLimiter({ capacity: 2, refillPerSec: 1 }, 3, () => now);
    l.take("spent");
    l.take("spent");
    now = 100;
    for (const k of ["k1", "k2", "k3", "k4", "k5"]) l.take(k);
    expect(l.size).toBeLessThanOrEqual(3);
    // An evicted bucket starts full: eviction never blocks a client.
    expect(l.take("spent").allowed).toBe(true);
  });
});

describe("parsePluginPath", () => {
  it("reads slug and operation within the op-event table's bounds", () => {
    expect(parsePluginPath("/api/plugin/forms/submit")).toEqual({
      slug: "forms",
      operation: "submit",
    });
    expect(parsePluginPath(`/api/plugin/${"a".repeat(64)}/x`)).not.toBeNull();
  });

  it("refuses an over-long or malformed name without looking it up", () => {
    for (const p of [
      `/api/plugin/${"a".repeat(65)}/x`,
      `/api/plugin/forms/${"o".repeat(121)}`,
      "/api/plugin/Forms/submit",
      "/api/plugin/forms/submit/extra",
      "/api/plugin/forms",
      "/api/plugins/forms/submit",
    ]) {
      expect(parsePluginPath(p)).toBeNull();
    }
  });
});

describe("refusePluginRequest", () => {
  const LIVE = ["https://example.com", "https://www.example.com"];
  const post = (headers: Record<string, string>) =>
    new Request("https://example.com/api/plugin/forms/submit", { method: "POST", headers });

  it("accepts JSON from a live origin", () => {
    expect(
      refusePluginRequest(
        post({ "content-type": "application/json; charset=utf-8", origin: "https://example.com" }),
        LIVE,
      ),
    ).toBeNull();
  });

  it("refuses anything but JSON", () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      expect(
        refusePluginRequest(post({ "content-type": type, origin: "https://example.com" }), LIVE),
      ).toEqual({ kind: "UnsupportedMediaType", status: 415 });
    }
    expect(refusePluginRequest(post({ origin: "https://example.com" }), LIVE)?.kind).toBe(
      "UnsupportedMediaType",
    );
  });

  it("refuses a foreign, the staging and a missing Origin", () => {
    for (const origin of ["https://evil.example", "https://staging.example.com", null]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (origin) headers.origin = origin;
      expect(refusePluginRequest(post(headers), LIVE)).toEqual({
        kind: "OriginNotAllowed",
        status: 403,
      });
    }
  });
});

describe("withJsonSecurityHeaders", () => {
  it("adds every header to a JSON answer, also one with immutable headers", async () => {
    const upstream = await fetch("data:application/json,{}");
    for (const res of [Response.json({ ok: true }), upstream]) {
      const out = withJsonSecurityHeaders(res);
      for (const [name, value] of Object.entries(JSON_SECURITY_HEADERS)) {
        expect(out.headers.get(name)).toBe(value);
      }
    }
  });

  it("leaves a non-JSON answer alone", () => {
    const res = new Response("<p>x</p>", { headers: { "content-type": "text/html" } });
    expect(withJsonSecurityHeaders(res).headers.get("x-frame-options")).toBeNull();
  });
});
