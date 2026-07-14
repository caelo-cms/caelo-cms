// SPDX-License-Identifier: MPL-2.0

/**
 * issue #229 — mode-selection contract for `propose_site_import`. The
 * tool's Zod schema and the underlying `imports.propose_run` op input
 * MUST agree that LIST mode (`urls`) and DEPTH mode (`depth`/`maxPages`)
 * are mutually exclusive, that `sourceUrl` is always required, that the
 * URL entries are validated absolute URLs, and that the list is capped.
 * These two schemas are the boundary the flow (#278) depends on; a drift
 * between them silently breaks the skill's `urls` instruction.
 */

import { describe, expect, it } from "bun:test";
import type { z } from "zod";
import { proposeImportRunInput } from "../../ops/imports.js";
import { proposeSiteImportTool } from "./propose-site-import.js";

// Both boundaries enforce the same mode-selection rule; run every case
// through each so they can never drift apart.
const schemas: Array<[string, z.ZodType]> = [
  ["tool", proposeSiteImportTool.schema as unknown as z.ZodType],
  ["op", proposeImportRunInput as unknown as z.ZodType],
];

for (const [label, schema] of schemas) {
  describe(`propose_site_import mode selection — ${label} schema (#229)`, () => {
    it("accepts DEPTH mode (sourceUrl + depth/maxPages, no urls)", () => {
      const r = schema.safeParse({
        sourceUrl: "https://site.example/",
        depth: 2,
        maxPages: 50,
      });
      expect(r.success).toBe(true);
    });

    it("accepts LIST mode (sourceUrl + urls, no depth/maxPages)", () => {
      const r = schema.safeParse({
        sourceUrl: "https://site.example/",
        urls: ["https://site.example/products", "https://site.example/blog/one"],
      });
      expect(r.success).toBe(true);
    });

    it("accepts a bare sourceUrl (depth mode via handler defaults)", () => {
      const r = schema.safeParse({ sourceUrl: "https://site.example/" });
      expect(r.success).toBe(true);
    });

    it("rejects mixing urls with depth (mutually exclusive)", () => {
      const r = schema.safeParse({
        sourceUrl: "https://site.example/",
        urls: ["https://site.example/a"],
        depth: 3,
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(JSON.stringify(r.error.issues)).toContain("mutually exclusive");
      }
    });

    it("rejects mixing urls with maxPages (mutually exclusive)", () => {
      const r = schema.safeParse({
        sourceUrl: "https://site.example/",
        urls: ["https://site.example/a"],
        maxPages: 10,
      });
      expect(r.success).toBe(false);
    });

    it("requires sourceUrl even in list mode", () => {
      const r = schema.safeParse({ urls: ["https://site.example/a"] });
      expect(r.success).toBe(false);
    });

    it("rejects a non-absolute / malformed URL in the list", () => {
      const r = schema.safeParse({
        sourceUrl: "https://site.example/",
        urls: ["/relative/path"],
      });
      expect(r.success).toBe(false);
    });

    it("rejects an empty urls array (min 1)", () => {
      const r = schema.safeParse({ sourceUrl: "https://site.example/", urls: [] });
      expect(r.success).toBe(false);
    });

    it("caps the list at 200 URLs", () => {
      const many = Array.from({ length: 201 }, (_, i) => `https://site.example/p${i}`);
      const r = schema.safeParse({ sourceUrl: "https://site.example/", urls: many });
      expect(r.success).toBe(false);

      const okCount = Array.from({ length: 200 }, (_, i) => `https://site.example/p${i}`);
      const ok = schema.safeParse({ sourceUrl: "https://site.example/", urls: okCount });
      expect(ok.success).toBe(true);
    });
  });
}
