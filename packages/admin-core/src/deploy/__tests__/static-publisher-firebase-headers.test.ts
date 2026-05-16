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

import { VERSION_CONFIG_HEADERS } from "../static-publisher-firebase.js";

describe("VERSION_CONFIG_HEADERS — Firebase Hosting REST API shape", () => {
  it("is a non-empty array of header-config entries", () => {
    expect(Array.isArray(VERSION_CONFIG_HEADERS)).toBe(true);
    expect(VERSION_CONFIG_HEADERS.length).toBeGreaterThan(0);
  });

  it("every entry has glob: string + headers: object (map, NOT array)", () => {
    for (const entry of VERSION_CONFIG_HEADERS) {
      expect(typeof entry.glob).toBe("string");
      expect(entry.glob.length).toBeGreaterThan(0);

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

  it("includes Cache-Control for hashed Vite assets + HTML (the two policies the GCS publisher mirrors)", () => {
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
