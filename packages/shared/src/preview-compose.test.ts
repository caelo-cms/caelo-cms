// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  ComposeError,
  composePagePreview,
  composePageWithLayout,
  tagModuleId,
} from "./preview-compose.js";

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

describe("composePagePreview substitutes {{name}} placeholders with field defaults", () => {
  // PR #61 follow-up: before this, modules with `{{name}}` placeholders
  // and a declared `fields[]` shipped raw to the browser via the
  // static-generator path (visitors saw literal `{{spantext}}` /
  // `{{ctahref}}` text). The substitution lives in compose so both the
  // preview-iframe path and the static-gen path agree on the default
  // floor. Per-placement overrides (content_instances.values) still
  // happen in preview-render, not here.
  const slot = `<body><caelo-slot name="content">_</caelo-slot></body>`;
  it("fills declared {{name}} placeholders with each field's default", () => {
    const out = composePagePreview({
      templateHtml: slot,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              moduleId: "mod-x",
              slug: "hero",
              displayName: "Hero",
              html: "<h1>{{heading}}</h1><a href=\"{{ctahref}}\">{{ctalabel}}</a>",
              css: "",
              js: "",
              fields: [
                { name: "heading", default: "Welcome to Caelo" },
                { name: "ctahref", default: "/get-started" },
                { name: "ctalabel", default: "Get started" },
              ],
            },
          ],
        },
      ],
    });
    expect(out.html).toContain(">Welcome to Caelo</h1>");
    expect(out.html).toContain('<a href="/get-started">Get started</a>');
    // No raw `{{name}}` residue in the body.
    expect(out.html).not.toMatch(/\{\{[a-z]/i);
  });
  it("leaves unknown {{name}} as raw placeholder (no-fallbacks per CLAUDE.md §2)", () => {
    const out = composePagePreview({
      templateHtml: slot,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              moduleId: "mod-y",
              slug: "broken",
              displayName: "Broken",
              html: "<p>{{declared}} and {{undeclared}}</p>",
              css: "",
              js: "",
              fields: [{ name: "declared", default: "OK" }],
            },
          ],
        },
      ],
    });
    expect(out.html).toContain(">OK and {{undeclared}}</p>");
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

describe("composePageWithLayout", () => {
  const layoutHtml = `<!doctype html><html><head></head><body><header><caelo-slot name="header">_</caelo-slot></header><main><caelo-slot name="content">_</caelo-slot></main></body></html>`;
  const templateHtml = `<body><caelo-slot name="content">_</caelo-slot></body>`;

  it("aggregates CSS in layout → template → modules order", () => {
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "/* TPL */",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              ...blankModule,
              moduleId: "11111111-1111-1111-1111-111111111111",
              html: "<p>x</p>",
              css: "/* MOD */",
            },
          ],
        },
      ],
      layoutHtml,
      layoutCss: "/* LAYOUT */",
      layoutBlocks: [],
      layoutSlug: "test",
    });
    const css = out.html.slice(
      out.html.indexOf(`<style data-source="modules">`),
      out.html.indexOf("</style>", out.html.indexOf(`<style data-source="modules">`)),
    );
    const layoutIdx = css.indexOf("/* LAYOUT */");
    const tplIdx = css.indexOf("/* TPL */");
    const modIdx = css.indexOf("/* MOD */");
    expect(layoutIdx).toBeGreaterThanOrEqual(0);
    expect(tplIdx).toBeGreaterThan(layoutIdx);
    expect(modIdx).toBeGreaterThan(tplIdx);
  });

  it("throws ComposeError when the layout lacks a content slot", () => {
    expect(() =>
      composePageWithLayout({
        templateHtml,
        templateCss: "",
        blocks: [],
        layoutHtml: `<!doctype html><html><body><header>chrome</header></body></html>`,
        layoutCss: "",
        layoutBlocks: [],
        layoutSlug: "broken",
      }),
    ).toThrow(ComposeError);
  });

  it("peels a body-wrapping <caelo-slot name='content'> with single-quote attrs", () => {
    // Single-quote attribute would have failed the previous regex peel
    // and produced a nested <caelo-slot> in the output. With the
    // parser-based peel, the wrapping slot is removed and the inner
    // <p>BODY</p> lands directly in the layout's content slot.
    const out = composePageWithLayout({
      templateHtml: `<body><caelo-slot name='content'>_</caelo-slot></body>`,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [{ ...blankModule, html: "<p>BODY</p>" }],
        },
      ],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
    });
    expect(out.html).toContain("<p");
    expect(out.html).toContain(">BODY</p>");
    // Exactly one caelo-slot[name=content] in output (the layout's own).
    const matches = out.html.match(/caelo-slot[^>]*name=["']content["']/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
