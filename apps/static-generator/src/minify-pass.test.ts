// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { composePageWithLayout } from "@caelo-cms/shared";
import { MinifyCache, minifyCss, minifyJs, minifyPageAssets } from "./minify-pass.js";

const layoutHtml =
  '<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content"></caelo-slot></body></html>';
const templateHtml = '<main><caelo-slot name="content"></caelo-slot></main>';

function composedPage(css: string, js: string): { html: string; pageSlug: string } {
  const out = composePageWithLayout({
    templateHtml,
    templateCss: "",
    blocks: [
      {
        blockName: "content",
        modules: [
          {
            moduleId: "11111111-1111-4111-8111-111111111111",
            slug: "hero",
            displayName: "Hero",
            html: '<section class="hero"><h1>Hi</h1></section>',
            css,
            js,
          },
        ],
      },
    ],
    layoutHtml,
    layoutCss: "",
    layoutBlocks: [],
    layoutSlug: "test",
  });
  return { html: out.html, pageSlug: "home" };
}

describe("minifyPageAssets (issue #158)", () => {
  it("minifies the composer's module CSS and JS and leaves the markup alone", async () => {
    const page = composedPage(
      ".hero {\n  color: #ff0000;\n  margin: 0px 0px;\n}\n",
      "(function () {\n  var greeting = 'hi';\n  console.log(greeting);\n})();\n",
    );
    await minifyPageAssets([page]);
    expect(page.html).toContain('<style data-source="modules">.hero{color:red;margin:0}</style>');
    expect(page.html).toContain(
      '<script defer data-source="modules">(function(){var n="hi";console.log(n)})();</script>',
    );
    expect(page.html).toContain('<section class="hero"');
    // The base stylesheet is composer-owned too.
    expect(page.html).not.toMatch(/<style data-source="base">\s/);
  });

  it("leaves plugin-contributed and foreign tags untouched", async () => {
    const page = {
      html: '<head><style data-plugin="x">a { color: red; }</style></head><body><script type="module">let  a = 1;</script></body>',
      pageSlug: "p",
    };
    const before = page.html;
    await minifyPageAssets([page]);
    expect(page.html).toBe(before);
  });

  it("keeps CSS and JS unable to close their element early", async () => {
    expect(await minifyCss('.a { content: "<\\/style>"; }')).toBe('.a{content:"<\\/style>"}');
    expect(await minifyJs('var s = "<\\/script>";', "p")).toBe('var s="<\\/script>";');
  });

  it("keeps classic-script semantics: directives and top-level names survive", async () => {
    const out = await minifyJs(
      "(function () { 'use strict'; return this; })();\nfunction sharedHelper(value) { return value; }",
      "p",
    );
    expect(out).toContain('"use strict"');
    expect(out).toContain("function sharedHelper(");
  });

  it("passes invalid CSS through so the browser drops what it dropped before", async () => {
    expect(await minifyCss(".x { color: red } }} .y { color: blue }")).toBe(
      ".x{color:red}}} .y{color:#00f}",
    );
  });

  it("refuses the build when the page script does not parse, naming the page and the fix", async () => {
    const page = composedPage("", "function broken( {");
    await expect(minifyPageAssets([page])).rejects.toThrow(
      /page slug=home: the page's module JavaScript does not parse[\s\S]*update_modules_many/,
    );
  });

  it("minifies a body once across batches and keeps the cache bounded (#1271)", async () => {
    const cache = new MinifyCache();
    const a = composedPage(".x { color: red; }", "");
    const b = composedPage(".x { color: red; }", "");
    await minifyPageAssets([a], cache);
    const cachedEntries = cache.css.size;
    await minifyPageAssets([b], cache);
    expect(cache.css.size).toBe(cachedEntries);
    expect(b.html).toBe(a.html);
    for (let i = 0; i < MinifyCache.MAX_ENTRIES + 10; i += 1) {
      await cache.get("css", `.y${i}{}`, async () => `.y${i}{}`);
    }
    expect(cache.css.size).toBeLessThanOrEqual(MinifyCache.MAX_ENTRIES);
  });
});
