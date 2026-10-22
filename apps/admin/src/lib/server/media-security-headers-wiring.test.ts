// SPDX-License-Identifier: MPL-2.0

/**
 * #863 (H-04) — media served from the admin origin carries the shared media
 * security headers (`mediaSecurityHeaders`, @caelo-cms/shared — its own unit
 * test pins the header values). This pins the wiring: both /_caelo/media
 * routes spread them into their responses.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("admin media routes", () => {
  it("serve mediaSecurityHeaders (read as source: bun cannot resolve #lib)", () => {
    for (const route of ["[slug]/+server.ts", "[assetId]/[variant]/+server.ts"]) {
      const src = readFileSync(
        resolve(import.meta.dir, "../../routes/_caelo/media", route),
        "utf8",
      );
      expect(src).toContain("...mediaSecurityHeaders(contentType)");
    }
  });
});
