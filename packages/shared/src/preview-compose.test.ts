// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { composePagePreview, tagModuleId } from "./preview-compose.js";

const blankModule = {
  moduleId: "00000000-0000-0000-0000-000000000000",
  slug: "blank",
  displayName: "Blank",
  html: "",
  css: "",
  js: "",
};

describe("composePagePreview", () => {
  it("inlines module HTML into named slots and stamps CSS/JS into head/body", () => {
    const out = composePagePreview({
      templateHtml: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">x</caelo-slot></body></html>`,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              ...blankModule,
              html: "<p>HELLO</p>",
              css: "p { color: red; }",
              js: "console.log('hi');",
            },
          ],
        },
      ],
    });
    expect(out.html).toContain(
      `<caelo-slot name="content"><p data-caelo-module-id="00000000-0000-0000-0000-000000000000">HELLO</p></caelo-slot>`,
    );
    expect(out.html).toContain(`<style data-source="modules">`);
    expect(out.html).toContain(`p { color: red; }`);
    expect(out.html).toContain(`<script defer data-source="modules">`);
    expect(out.html).toContain(`console.log('hi');`);
    // CSS appears before </head>; JS before </body>.
    expect(out.html.indexOf(`<style data-source="modules">`)).toBeLessThan(
      out.html.indexOf("</head>"),
    );
    expect(out.html.indexOf(`<script defer data-source="modules">`)).toBeLessThan(
      out.html.indexOf("</body>"),
    );
  });

  it("orders modules within a block by array order", () => {
    const out = composePagePreview({
      templateHtml: `<body><caelo-slot name="x">_</caelo-slot></body>`,
      templateCss: "",
      blocks: [
        {
          blockName: "x",
          modules: [
            { ...blankModule, html: "<p>A</p>" },
            { ...blankModule, html: "<p>B</p>" },
          ],
        },
      ],
    });
    // Both modules use the same blank moduleId so the data-attr collides;
    // ordering is what matters here. Just assert both are present in
    // sequence with the expected separator.
    expect(out.html).toMatch(
      /<p data-caelo-module-id="[^"]+">A<\/p>\n<p data-caelo-module-id="[^"]+">B<\/p>/,
    );
  });

  it("emits template CSS before module CSS so module rules win on tie specificity", () => {
    const out = composePagePreview({
      templateHtml: `<head></head><body></body>`,
      templateCss: "body { color: blue; }",
      blocks: [
        {
          blockName: "x",
          modules: [{ ...blankModule, css: "body { color: red; }" }],
        },
      ],
    });
    const cssBlock = out.html.match(/<style data-source="modules">[\s\S]*?<\/style>/)?.[0] ?? "";
    expect(cssBlock.indexOf("color: blue")).toBeLessThan(cssBlock.indexOf("color: red"));
  });

  it("omits the style tag entirely when no module/template CSS exists", () => {
    const out = composePagePreview({
      templateHtml: `<head></head><body><caelo-slot name="x">_</caelo-slot></body>`,
      templateCss: "",
      blocks: [{ blockName: "x", modules: [{ ...blankModule, html: "<p>x</p>" }] }],
    });
    expect(out.html).not.toContain(`<style data-source="modules">`);
    expect(out.html).not.toContain(`<script defer data-source="modules">`);
  });

  it("records missing slot names when the template has unfilled slots", () => {
    const out = composePagePreview({
      templateHtml: `<body><caelo-slot name="missing">_</caelo-slot></body>`,
      templateCss: "",
      blocks: [],
    });
    expect(out.missingSlots).toEqual(["missing"]);
  });
});

describe("tagModuleId (P6.7 live-edit overlay support)", () => {
  it("adds data-caelo-module-id to the first opening tag", () => {
    expect(tagModuleId("<p>hello</p>", "abc-123")).toBe(
      `<p data-caelo-module-id="abc-123">hello</p>`,
    );
  });

  it("is idempotent — re-running on tagged HTML is a no-op", () => {
    const once = tagModuleId("<p>x</p>", "id-1");
    expect(tagModuleId(once, "id-1")).toBe(once);
  });

  it("only tags the FIRST opening tag — siblings stay untouched", () => {
    const out = tagModuleId("<p>a</p><p>b</p>", "id-1");
    expect(out).toBe(`<p data-caelo-module-id="id-1">a</p><p>b</p>`);
  });

  it("tolerates leading whitespace + comments before the first tag", () => {
    const out = tagModuleId("  <!-- hi -->\n<div>x</div>", "id-9");
    expect(out).toContain(`<div data-caelo-module-id="id-9">x</div>`);
  });

  it("returns unchanged when there is no opening tag (pure text)", () => {
    expect(tagModuleId("plain text", "id-1")).toBe("plain text");
  });

  it("preserves existing attributes on the first tag", () => {
    expect(tagModuleId(`<h1 class="hero" id="x">A</h1>`, "id-7")).toBe(
      `<h1 class="hero" id="x" data-caelo-module-id="id-7">A</h1>`,
    );
  });
});

describe("composePagePreview tags every module's outermost element", () => {
  const slot = `<body><caelo-slot name="content">_</caelo-slot></body>`;
  it("threads the moduleId through the composed output", () => {
    const out = composePagePreview({
      templateHtml: slot,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            { moduleId: "mod-a", slug: "a", displayName: "A", html: "<p>1</p>", css: "", js: "" },
            { moduleId: "mod-b", slug: "b", displayName: "B", html: "<p>2</p>", css: "", js: "" },
          ],
        },
      ],
    });
    expect(out.html).toContain(`<p data-caelo-module-id="mod-a">1</p>`);
    expect(out.html).toContain(`<p data-caelo-module-id="mod-b">2</p>`);
  });
});
