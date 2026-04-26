// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { composePagePreview } from "../preview/compose.js";

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
    expect(out.html).toContain(`<caelo-slot name="content"><p>HELLO</p></caelo-slot>`);
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
    expect(out.html).toContain(`<p>A</p>\n<p>B</p>`);
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
