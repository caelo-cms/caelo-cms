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
import {
  dataBlockJson,
  INLINE_CSS_MAX_BYTES,
  injectPluginAssets,
  type PluginClientAsset,
  plainJsonProblem,
  withAssetContent,
} from "./client-assets.js";

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
          // Above the inline limit, so it is linked (#1124 inlines smaller ones).
          content: `.x{}${" ".repeat(INLINE_CSS_MAX_BYTES)}`,
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

  it("inlines a small stylesheet on a deployed page instead of a blocking link (#1124)", () => {
    const html = injectPluginAssets(
      DOC,
      [asset({ fileName: "runtime.css", kind: "css", content: "[data-x]{display:none}" })],
      "linked",
    );
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toContain(
      '<style data-caelo-plugin="consent-manager">\n[data-x]{display:none}\n</style>',
    );
    expect(html.indexOf("<style")).toBeLessThan(html.indexOf("</head>"));
  });

  it("still links a stylesheet above the inline limit", () => {
    const content = `.x{}${" ".repeat(INLINE_CSS_MAX_BYTES)}`;
    const html = injectPluginAssets(
      DOC,
      [
        asset({
          fileName: "runtime.css",
          kind: "css",
          content,
          publicPath: "/_caelo/plugin/consent-manager/runtime.def456.css",
        }),
      ],
      "linked",
    );
    expect(html).toContain(
      '<link rel="stylesheet" href="/_caelo/plugin/consent-manager/runtime.def456.css"',
    );
    expect(html).not.toContain("<style");
  });

  it("escapes a closing </style> in a small stylesheet inlined on a deployed page", () => {
    const html = injectPluginAssets(
      DOC,
      [asset({ kind: "css", content: ".x{content:'</style><script>evil()</script>'}" })],
      "linked",
    );
    expect(html).not.toContain("</style><script>");
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

describe("withAssetContent", () => {
  it("names the file by the hash of the new body", () => {
    const source = asset({ content: "console.log( 1 );\n" });
    const a = withAssetContent(source, "console.log(1);");
    const b = withAssetContent(source, "console.log(2);");
    expect(a.content).toBe("console.log(1);");
    expect(a.relPath).toMatch(/^_caelo\/plugin\/consent-manager\/runtime\.[0-9a-f]{12}\.js$/);
    expect(a.publicPath).toBe(`/${a.relPath}`);
    expect(a.relPath).not.toBe(b.relPath);
    expect(withAssetContent(source, "console.log(1);").relPath).toBe(a.relPath);
  });

  it("inlines the new body where small CSS is inlined", () => {
    const css = withAssetContent(
      asset({ fileName: "runtime.css", kind: "css", content: ".a {\n  color: red;\n}\n" }),
      ".a{color:red}",
    );
    const html = injectPluginAssets(DOC, [css], "linked");
    expect(html).toContain(".a{color:red}");
    expect(html).not.toContain("color: red");
  });
});

describe("#1729 — consent-gated scripts and build data", () => {
  it("parks a script that needs consent, so nothing of it loads before", () => {
    for (const mode of ["linked", "inline"] as const) {
      const html = injectPluginAssets(
        DOC,
        [asset({ pluginSlug: "probe", consent: ["analytics", "marketing"] })],
        mode,
      );
      expect(html).toContain('<script type="text/plain" data-caelo-consent="analytics marketing"');
      expect(html).not.toContain("<script defer");
      expect(html).not.toMatch(/<script[^>]* src=/);
      const src = /data-caelo-src="([^"]+)"/.exec(html)?.[1] ?? "";
      if (mode === "linked") expect(src).toBe("/_caelo/plugin/consent-manager/runtime.abc123.js");
      // The preview parks the same bytes, so the provider starts it the same way.
      else expect(Buffer.from(src.split(",")[1] ?? "", "base64").toString()).toBe("console.log(1)");
    }
  });

  it("puts each data block before the scripts, in both modes alike", () => {
    const data = asset({ kind: "data", fileName: "data.json", content: '{"a":1}' });
    const linked = injectPluginAssets(DOC, [asset(), data], "linked");
    const inline = injectPluginAssets(DOC, [asset(), data], "inline");
    const block =
      '<script type="application/json" data-caelo-plugin-data="consent-manager">{"a":1}</script>';
    for (const html of [linked, inline]) {
      expect(html).toContain(block);
      expect(html.indexOf(block)).toBeLessThan(html.indexOf("<script defer"));
    }
  });

  it("escapes what could end or change a data block", () => {
    const json = dataBlockJson({ a: "</script><!--<script>", b: "\u2028\u2029" });
    expect(json).not.toContain("<");
    expect(json).not.toContain("\u2028");
    expect(JSON.parse(json)).toEqual({ a: "</script><!--<script>", b: "\u2028\u2029" });
  });

  it.each([
    [{ __proto__: null, ok: 1 }, null],
    [JSON.parse('{"__proto__":{"x":1}}'), 'data: the key "__proto__"'],
    [{ a: [{ constructor: 1 }] }, 'data.a[0]: the key "constructor"'],
    [{ a: () => 1 }, "data.a: a function is not JSON"],
    [{ a: Number.NaN }, "data.a: not a finite number"],
    [{ a: new Map() }, "data.a: not a plain object"],
  ])("plain JSON only: %p", (value, problem) => {
    const found = plainJsonProblem(value);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toStartWith(problem);
  });
});
