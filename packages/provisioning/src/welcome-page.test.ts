// SPDX-License-Identifier: MPL-2.0

/**
 * #781 — contracts of `static/welcome.html`, the placeholder the GCP
 * wizard uploads to a fresh static bucket. It must stay fully
 * self-contained (the bucket holds nothing else, and a first impression
 * that fetches from third parties leaks the visitor), keep the
 * `{{ADMIN_URL}}` placeholder the wizard substitutes, and carry the
 * Caelatum sky instead of the old animated mesh.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../static/welcome.html", import.meta.url), "utf8");

describe("welcome.html", () => {
  it("makes no external requests", () => {
    // Any absolute or protocol-relative URL, stylesheet/script/image
    // reference or CSS import/url() would be a network fetch.
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/["'(]\s*\/\//);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/@import|url\(|@font-face/i);
    expect(html).not.toMatch(/\b(src|href)\s*=/i);
  });

  it("keeps the admin URL placeholder the wizard substitutes", () => {
    expect(html).toContain("{{ADMIN_URL}}");
  });

  it("uses the sky + relief plate with the inline mark, not the mesh", () => {
    expect(html).toContain("#c3dbf2 0%, #dce9f6 40%, #efe7ef 72%, #f8e6d8 100%");
    expect(html).toContain("0 0 0 5px var(--plate-ring)");
    expect(html).toMatch(/<svg viewBox="0 0 32 32" aria-hidden="true"/);
    expect(html).not.toMatch(/class="blob|@keyframes (drift|pulse)/);
  });
});
