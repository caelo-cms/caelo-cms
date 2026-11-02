// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { JSON_SECURITY_HEADERS, withJsonSecurityHeaders } from "./json-security-headers.js";

describe("withJsonSecurityHeaders", () => {
  it("adds every header to a JSON answer and keeps one already set", () => {
    const res = withJsonSecurityHeaders(
      new Response("{}", {
        headers: { "content-type": "application/json; charset=utf-8", "referrer-policy": "origin" },
      }),
    );
    expect(res.headers.get("referrer-policy")).toBe("origin");
    expect(res.headers.get("x-frame-options")).toBe(JSON_SECURITY_HEADERS["X-Frame-Options"] ?? "");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("leaves a non-JSON answer as it is", () => {
    const res = withJsonSecurityHeaders(
      new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } }),
    );
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("rebuilds an answer with immutable headers around the same body", async () => {
    const upstream = Response.json({ ok: true });
    const res = withJsonSecurityHeaders(upstream);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await res.json()).toEqual({ ok: true });
  });
});
