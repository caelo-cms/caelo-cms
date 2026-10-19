// SPDX-License-Identifier: MPL-2.0

/**
 * Referencing plugin client assets from a page.
 *
 * The load-bearing cases are placement and parity. CSS must land in
 * `<head>` (a plugin surface that flashes unstyled is a visible defect)
 * and JS last in `<body>` deferred (a runtime that blocks first paint
 * is worse than the problem it solves). Linked and inline modes must
 * carry the same content, because the editor preview uses one and the
 * deploy the other — a consent dialog that works in preview and is
 * missing on the live site is exactly what this parity prevents.
 */

import { describe, expect, it } from "bun:test";
import { injectPluginAssets, type PluginClientAsset } from "./client-assets.js";

const DOC = "<html><head><title>t</title></head><body><main>x</main></body></html>";

function asset(over: Partial<PluginClientAsset> = {}): PluginClientAsset {
  return {
    pluginSlug: "consent-manager",
    fileName: "runtime.js",
    kind: "js",
    content: "console.log(1)",
    relPath: "_caelo/plugin/consent-manager/runtime.abc123.js",
    publicPath: "/_caelo/plugin/consent-manager/runtime.abc123.js",
    ...over,
  };
}

describe("plugin client assets — page injection", () => {
  it("links JS deferred at the end of body and CSS in head", () => {
    const html = injectPluginAssets(
      DOC,
      [
        asset(),
        asset({
          fileName: "runtime.css",
          kind: "css",
          content: ".x{}",
          publicPath: "/_caelo/plugin/consent-manager/runtime.def456.css",
        }),
      ],
      "linked",
    );
    expect(html).toContain(
      '<link rel="stylesheet" href="/_caelo/plugin/consent-manager/runtime.def456.css"',
    );
    expect(html).toContain('<script defer src="/_caelo/plugin/consent-manager/runtime.abc123.js"');
    // Placement, not just presence.
    expect(html.indexOf('<link rel="stylesheet"')).toBeLessThan(html.indexOf("</head>"));
    expect(html.indexOf("<script defer")).toBeGreaterThan(html.indexOf("<main>"));
  });

  it("inlines the identical content for the preview", () => {
    const html = injectPluginAssets(DOC, [asset()], "inline");
    expect(html).toContain("console.log(1)");
    // No src — the preview iframe has no build directory to serve from.
    expect(html).not.toContain("src=");
    expect(html).toContain('data-caelo-plugin="consent-manager"');
  });

  it("inlines plugin content verbatim, even with `$` replacement patterns", () => {
    // A string replacement would expand `$&` / `$'` inside the content.
    const content = 'var a = s.replace(/x/, "$&$\'");';
    const html = injectPluginAssets(DOC, [asset({ content })], "inline");
    expect(html).toContain(content);
  });

  it("leaves a fragment untouched", () => {
    // The module-only preview render is not a document and cannot carry
    // a runtime; silently appending to it would produce stray tags.
    const frag = "<section>hi</section>";
    expect(injectPluginAssets(frag, [asset()], "linked")).toBe(frag);
  });

  it("is a no-op when no plugin contributes", () => {
    expect(injectPluginAssets(DOC, [], "linked")).toBe(DOC);
  });

  it("escapes the reference so a slug can never break out of the attribute", () => {
    const html = injectPluginAssets(
      DOC,
      [asset({ publicPath: '/x".js" onload="evil()' })],
      "linked",
    );
    expect(html).not.toContain('onload="evil()"');
    expect(html).toContain("&quot;");
  });

  it("escapes closing </style> and </script> tags in inline mode", () => {
    const html = injectPluginAssets(
      DOC,
      [
        asset({ kind: "css", content: ".x{content:'</style><script>evil()</script>'}" }),
        asset({ kind: "js", content: 'const s = "</script><script>evil()</script>";' }),
      ],
      "inline",
    );
    expect(html).not.toContain("</style><script>");
    expect(html).not.toContain("</script><script>");
  });

  it("ships a JS asset that spells </script as a data: URL carrying the exact bytes", () => {
    // `0</script/.test(v)` is valid JS that any `<\/script` rewrite breaks.
    const content = "const v = 1; window.r = 0</script/.test(String(v));";
    const html = injectPluginAssets(DOC, [asset({ kind: "js", content })], "inline");
    const src = /<script defer src="data:text\/javascript;charset=utf-8;base64,([^"]+)"/.exec(html);
    expect(src).not.toBeNull();
    expect(Buffer.from(src?.[1] ?? "", "base64").toString("utf8")).toBe(content);
    expect(html).not.toContain("0</script/");
  });

  it("encodes a JS asset holding <!-- too (script-data escape would swallow the close)", () => {
    const content = "var s = '<!--<script>';";
    const html = injectPluginAssets(DOC, [asset({ kind: "js", content })], "inline");
    const src = /<script defer src="data:text\/javascript;charset=utf-8;base64,([^"]+)"/.exec(html);
    expect(src).not.toBeNull();
    expect(Buffer.from(src?.[1] ?? "", "base64").toString("utf8")).toBe(content);
  });
});
