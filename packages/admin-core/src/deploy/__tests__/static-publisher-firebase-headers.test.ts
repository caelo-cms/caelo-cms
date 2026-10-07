// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.3 — regression test for the Firebase Hosting REST API headers
 * schema. The Firebase CLI's firebase.json takes
 * `headers: [{key, value}]` per entry; the REST API at
 * sites.versions.create takes `headers: { key: value }` (map). We
 * deploy via the REST API, not the CLI, so we MUST use the map shape.
 *
 * The v0.3.1 → v0.6.2 publisher used the CLI shape, which made every
 * staging deploy fail with:
 *   400 Bad Request — Invalid value at 'version.config.headers[0]'
 *   (Map), Cannot bind a list to map for field 'headers'.
 *
 * This test pins the contract structurally: each entry in
 * `VERSION_CONFIG_HEADERS` must have a `headers` field that is a
 * plain object with string keys + string values. If a future refactor
 * silently flips the shape back, this test fails before the deploy
 * does.
 *
 * Spec reference:
 *   https://firebase.google.com/docs/reference/hosting/rest/v1beta1/sites.versions#Header
 */

import { describe, expect, it } from "bun:test";

import { HTML_CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL } from "@caelo-cms/shared";
import { VERSION_CONFIG_HEADERS } from "../static-publisher-firebase.js";

describe("VERSION_CONFIG_HEADERS — Firebase Hosting REST API shape", () => {
  it("is a non-empty array of header-config entries", () => {
    expect(Array.isArray(VERSION_CONFIG_HEADERS)).toBe(true);
    expect(VERSION_CONFIG_HEADERS.length).toBeGreaterThan(0);
  });

  it("every entry has exactly one of glob / regex + headers: object (map, NOT array)", () => {
    for (const entry of VERSION_CONFIG_HEADERS) {
      const e = entry as { glob?: unknown; regex?: unknown };
      const matchers = [e.glob, e.regex].filter((m) => m !== undefined);
      expect(matchers.length).toBe(1);
      expect(typeof matchers[0]).toBe("string");
      expect((matchers[0] as string).length).toBeGreaterThan(0);

      // The bug: an earlier version emitted `headers: [{key, value}]`
      // (the Firebase CLI's firebase.json shape). Reject arrays here.
      expect(Array.isArray(entry.headers)).toBe(false);
      expect(typeof entry.headers).toBe("object");
      expect(entry.headers).not.toBeNull();

      // Every key + value must be a string (map<string, string>).
      for (const [k, v] of Object.entries(entry.headers as Record<string, unknown>)) {
        expect(typeof k).toBe("string");
        expect(typeof v).toBe("string");
      }
    }
  });

  it("includes Cache-Control for hashed assets + HTML (the two policies the GCS publisher mirrors)", () => {
    const allHeaders = VERSION_CONFIG_HEADERS.flatMap((e) =>
      Object.entries(e.headers as Record<string, string>),
    );
    const cacheControls = allHeaders.filter(([k]) => k === "Cache-Control").map(([, v]) => v);
    expect(cacheControls.some((v) => v.includes("immutable"))).toBe(true);
    expect(cacheControls.some((v) => v.includes("stale-while-revalidate"))).toBe(true);
  });

  it("JSON-serialises into the exact shape Firebase's REST API accepts (smoke)", () => {
    // Round-trip through JSON.stringify + parse to confirm no funny
    // shape (e.g., Symbol keys) leaks in. The serialised entry's
    // `headers` field must remain an object literal post-parse.
    const json = JSON.stringify({ headers: VERSION_CONFIG_HEADERS });
    const parsed = JSON.parse(json) as {
      headers: { glob: string; headers: Record<string, string> }[];
    };
    expect(parsed.headers.length).toBe(VERSION_CONFIG_HEADERS.length);
    for (const e of parsed.headers) {
      expect(Array.isArray(e.headers)).toBe(false);
      expect(typeof e.headers).toBe("object");
    }
  });
});

/**
 * Evaluate the version config the way Firebase does: every entry whose
 * matcher hits the REQUEST URL path contributes its headers. Entries
 * here are all `regex` (RE2); the patterns stay inside the
 * RE2 ∩ ECMAScript subset, so `RegExp` gives the same answer.
 */
function cacheControlsFor(path: string): string[] {
  const out: string[] = [];
  for (const entry of VERSION_CONFIG_HEADERS) {
    const { regex } = entry as { regex?: string };
    if (regex === undefined) throw new Error("glob entries are not evaluated by this helper");
    if (new RegExp(regex).test(path)) {
      out.push((entry.headers as Record<string, string>)["Cache-Control"] ?? "");
    }
  }
  return out;
}

describe("VERSION_CONFIG_HEADERS — Cache-Control per path class", () => {
  it("content-hashed fonts + plugin bundles are immutable for a year (Lighthouse uses-long-cache-ttl)", () => {
    for (const p of [
      "/_assets/fonts/inter/29ede7bd4be32ab0.woff2",
      "/_assets/fonts/manrope/f3a06e9b32049b82.woff2",
      `/_assets/fonts/pinned/${"c".repeat(64)}.woff2`,
      "/_caelo/plugin/consent-manager/runtime.0123456789ab.js",
      "/_app/immutable/chunks/abc.js",
    ]) {
      expect(cacheControlsFor(p)).toEqual([IMMUTABLE_CACHE_CONTROL]);
    }
  });

  it("pages + robots/sitemap get the short revalidating policy, whatever the URL style", () => {
    for (const p of [
      "/",
      "/about/",
      "/about",
      "/about.html",
      "/en/about/index.html",
      "/apiary/",
      "/a",
      "/ap",
      "/robots.txt",
      "/sitemap.xml",
      "/routing-manifest.json",
    ]) {
      expect(cacheControlsFor(p)).toEqual([HTML_CACHE_CONTROL]);
    }
  });

  it("slug-addressed media and the /api gateway rewrite match no rule (never immutable)", () => {
    for (const p of [
      "/_assets/searchviu-logo.png",
      "/_assets/hero/w800.webp",
      "/_assets/fonts/pinned/0b1f6c2e-9d7a-4c1e-8f3a-2b6d9e0c1a4f.license.txt",
      "/_caelo/plugin/consent-manager/runtime.js",
      "/api",
      "/api/forms/submit",
    ]) {
      expect(cacheControlsFor(p)).toEqual([]);
    }
  });
});
