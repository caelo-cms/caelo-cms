// SPDX-License-Identifier: MPL-2.0

/**
 * Regression tests for `sanitizeSvg` (issue #113, S6 — js/bad-tag-filter +
 * js/incomplete-multi-character-sanitization). The sanitizer must be
 * re-creation-proof (run to a fixed point) and must match the script
 * end-tag variants HTML actually accepts.
 */

import { describe, expect, it } from "bun:test";
import { sanitizeSvg } from "../pipeline.js";

describe("sanitizeSvg", () => {
  it("removes a simple <script> element", () => {
    expect(sanitizeSvg("<svg><script>alert(1)</script></svg>")).toBe("<svg></svg>");
  });

  it("removes a split-injection that a single pass would re-create", () => {
    // Removing the inner <script>…</script> would otherwise re-join the
    // outer <scr + ipt> into a live <script>. The fixed-point loop catches it.
    const out = sanitizeSvg("<svg><scr<script>x</script>ipt>alert(1)</script></svg>");
    expect(out).not.toContain("<script");
    expect(out.toLowerCase()).not.toContain("<script");
  });

  it("matches the </script\\t\\n bar> end-tag variant (bad-tag-filter)", () => {
    const out = sanitizeSvg("<svg><script>x</script\t\n bar></svg>");
    expect(out).not.toContain("<script");
  });

  it("strips inline on* handlers and javascript: hrefs", () => {
    expect(sanitizeSvg('<svg onload="x()"></svg>')).not.toContain("onload");
    expect(sanitizeSvg('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
  });

  it("is idempotent", () => {
    const dirty = '<svg><script>a</script><rect onclick="b()"/></svg>';
    const once = sanitizeSvg(dirty);
    expect(sanitizeSvg(once)).toBe(once);
  });

  it("leaves a clean SVG untouched", () => {
    const clean = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    expect(sanitizeSvg(clean)).toBe(clean);
  });

  it("strips XML-namespaced script tags, foreignObject subtrees, and SMIL elements", () => {
    const dirty =
      '<svg xmlns:svg="http://www.w3.org/2000/svg">' +
      "<svg:script>alert(1)</svg:script>" +
      '<foreignObject><iframe srcdoc="<script>alert(2)</script>"></iframe></foreignObject>' +
      '<set attributeName="onload" to="alert(3)"/>' +
      '<animate attributeName="href" values="javascript:alert(4)"/>' +
      "</svg>";
    const out = sanitizeSvg(dirty);
    expect(out.toLowerCase()).not.toContain("script");
    expect(out.toLowerCase()).not.toContain("foreignobject");
    expect(out.toLowerCase()).not.toContain("<set");
    expect(out.toLowerCase()).not.toContain("<animate");
  });

  it("strips unquoted, whitespace-padded, entity-encoded, and data: href attributes", () => {
    expect(sanitizeSvg("<a href=javascript:alert(1)>x</a>")).not.toContain("javascript:");
    expect(sanitizeSvg('<a href="  javascript:alert(1)">x</a>')).not.toContain("javascript:");
    expect(sanitizeSvg('<a xlink:href="&#106;avascript:alert(1)">x</a>')).not.toContain("&#106;");
    expect(sanitizeSvg('<use href="data:image/svg+xml;base64,PHN2Zz4="/>')).not.toContain("data:");
  });
});
