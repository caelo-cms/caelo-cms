// SPDX-License-Identifier: MPL-2.0

/**
 * #1216 — the /_caelo/media routes stream the stored object instead of
 * reading it whole and copying it (the old path held the file plus a
 * Uint8Array copy plus a Blob per request). Read as source: bun cannot
 * resolve #lib, so the routes cannot be imported here; the stream itself
 * is covered by LocalVolumeAdapter's storage-stream test in admin-core.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("admin media routes stream (#1216)", () => {
  for (const route of ["[slug]/+server.ts", "[assetId]/[variant]/+server.ts"]) {
    it(`${route} serves openStream's body with its size, no whole-file copy`, () => {
      const src = readFileSync(
        resolve(import.meta.dir, "../../routes/_caelo/media", route),
        "utf8",
      );
      expect(src).toContain(".openStream(v.storageKey)");
      expect(src).toContain("new Response(file.body,");
      expect(src).toContain('"content-length": String(file.sizeBytes)');
      expect(src).toContain('"cache-control": "private, max-age=31536000, immutable"');
      expect(src).not.toContain("storage.get(");
      expect(src).not.toContain("new Blob(");
    });
  }
});
