// SPDX-License-Identifier: MPL-2.0

/**
 * issue #412 / PR #427 security review — the preview capture token must
 * ride ONLY on requests to the admin's own origin. A context-wide
 * `extraHTTPHeaders` would ship the credential to every third-party host
 * the rendered page embeds (fonts CDN, remote images, analytics); this
 * pins the route-level decision that prevents that.
 */

import { describe, expect, it } from "bun:test";
import {
  handleSameOriginRoute,
  type PlaywrightRoute,
  sameOriginHeaderPatch,
} from "./screenshot.js";

const SELF = "http://127.0.0.1:3000";
const TOKEN = { "x-caelo-preview-screenshot-token": "v1.payload.sig" };

function mockRoute(url: string, method = "GET", requestHeaders: Record<string, string> = {}) {
  let abortedWith: string | undefined;
  let continuedWith: { headers?: Record<string, string> } | undefined;
  let continued = false;
  const route: PlaywrightRoute = {
    request: () => ({
      url: () => url,
      method: () => method,
      headers: () => requestHeaders,
    }),
    abort: async (code) => {
      abortedWith = code ?? "aborted";
    },
    continue: async (opts) => {
      continued = true;
      continuedWith = opts;
    },
    fulfill: async () => {
      throw new Error("not used");
    },
  };
  return {
    route,
    getAborted: () => abortedWith,
    getContinued: () => continued,
    getContinuedWith: () => continuedWith,
  };
}

describe("sameOriginHeaderPatch", () => {
  it("injects the header for same-origin requests (navigation + assets)", () => {
    for (const url of [
      `${SELF}/_caelo/preview-screenshot/abc`,
      `${SELF}/_caelo/media/logo`,
      `${SELF}/_caelo/fonts/inter/0011223344556677.woff2`,
    ]) {
      const patched = sameOriginHeaderPatch(url, SELF, { accept: "*/*" }, TOKEN);
      expect(patched).toEqual({ accept: "*/*", ...TOKEN });
    }
  });

  it("NEVER injects for third-party hosts", () => {
    for (const url of [
      "https://fonts.googleapis.com/css2?family=Inter",
      "https://cdn.example.com/hero.jpg",
      "https://analytics.example.net/collect",
    ]) {
      expect(sameOriginHeaderPatch(url, SELF, {}, TOKEN)).toBeNull();
    }
  });

  it("treats a different port / scheme on the same host as cross-origin", () => {
    expect(sameOriginHeaderPatch("http://127.0.0.1:8082/page", SELF, {}, TOKEN)).toBeNull();
    expect(sameOriginHeaderPatch("https://127.0.0.1:3000/page", SELF, {}, TOKEN)).toBeNull();
  });

  it("refuses unparseable request URLs instead of guessing", () => {
    expect(sameOriginHeaderPatch("not a url", SELF, {}, TOKEN)).toBeNull();
    expect(sameOriginHeaderPatch("data:text/plain,x", SELF, {}, TOKEN)).toBeNull();
  });

  it("keeps existing request headers and lets the credential win on collision", () => {
    const patched = sameOriginHeaderPatch(
      `${SELF}/x`,
      SELF,
      { "user-agent": "chromium", "x-caelo-preview-screenshot-token": "stale" },
      TOKEN,
    );
    expect(patched).toEqual({ "user-agent": "chromium", ...TOKEN });
  });
});

describe("handleSameOriginRoute (fail-closed own-origin preview guard)", () => {
  it("continues same-origin GET/HEAD requests with the token header merged", async () => {
    const m = mockRoute(`${SELF}/_caelo/preview-screenshot/page-1`, "GET", { accept: "text/html" });
    await handleSameOriginRoute(m.route, SELF, TOKEN);
    expect(m.getAborted()).toBeUndefined();
    expect(m.getContinued()).toBe(true);
    expect(m.getContinuedWith()).toEqual({ headers: { accept: "text/html", ...TOKEN } });
  });

  it("aborts cross-origin, cloud metadata, other-port, and file:/data: requests instead of continuing", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://127.0.0.1:8080/internal",
      "https://evil.example/exfil",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      const m = mockRoute(url, "GET");
      await handleSameOriginRoute(m.route, SELF, TOKEN);
      expect(m.getAborted()).toBe("blockedbyclient");
      expect(m.getContinued()).toBe(false);
    }
  });

  it("aborts non-GET/HEAD requests even when targeting same-origin", async () => {
    const m = mockRoute(`${SELF}/api/users`, "POST", { "content-type": "application/json" });
    await handleSameOriginRoute(m.route, SELF, TOKEN);
    expect(m.getAborted()).toBe("blockedbyclient");
    expect(m.getContinued()).toBe(false);
  });
});
