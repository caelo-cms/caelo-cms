// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout D) — a link-resolve answer's `variant` is
 * interpolated into missing-slot markers and AI-facing text, so it is
 * limited to a plain token. Locale codes the international-site plugin
 * emits must keep passing.
 */

import { describe, expect, it } from "bun:test";
import { linkResolvePageVariant } from "./index.js";

describe("linkResolvePageVariant.variant", () => {
  it("accepts locale codes", () => {
    for (const variant of ["de", "en", "pt-BR", "zh-Hant-TW", "en_US", "x".repeat(64)]) {
      expect(linkResolvePageVariant.safeParse({ variant, group: null }).success).toBe(true);
    }
  });

  it("refuses tokens that would corrupt a marker or prompt text", () => {
    for (const variant of ["", "de:at", "de at", "de\nignore", "<b>", "x".repeat(65)]) {
      expect(linkResolvePageVariant.safeParse({ variant, group: "g" }).success).toBe(false);
    }
  });
});
