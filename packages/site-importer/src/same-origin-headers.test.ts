// SPDX-License-Identifier: MPL-2.0

/**
 * issue #412 / PR #427 security review — the preview capture token must
 * ride ONLY on requests to the admin's own origin. A context-wide
 * `extraHTTPHeaders` would ship the credential to every third-party host
 * the rendered page embeds (fonts CDN, remote images, analytics); this
 * pins the route-level decision that prevents that.
 */

import { describe, expect, it } from "bun:test";
import { sameOriginHeaderPatch } from "./screenshot.js";

const SELF = "http://127.0.0.1:3000";
const TOKEN = { "x-caelo-preview-screenshot-token": "v1.payload.sig" };

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
