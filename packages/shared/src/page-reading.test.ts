// SPDX-License-Identifier: MPL-2.0

/**
 * #1732 review, round 3 — a module's plugin values are checked as if it
 * stood in plain HTML content. A layout or template slot that stands
 * elsewhere, and a part of the page that ends outside content (a module
 * left raw text, SVG or a `<select>` open), make that untrue: the plugin
 * values are refused there. Core values render as before either way.
 */

import { describe, expect, it } from "bun:test";
import { pluginValue } from "./lists/plugin-values.js";
import type { NestedRenderResolver } from "./nested-module-render.js";
import { frameReading, OPEN_MARKUP_RULE, SLOT_PLACEMENT_RULE } from "./page-reading.js";
import { composePagePreview, composePageWithLayout } from "./preview-compose.js";

const ESCAPE = '<p title="</noscript><img src=x onerror=alert(1)>">Bitte JavaScript aktivieren</p>';
const owned = (value: string, type = "richtext") =>
  pluginValue({ plugin: "evil", point: "content-variants", address: "m/body", type }, value);
const refused = (rule: string) => `plugin-value-refused:evil.content-variants.m/body:${rule}`;

const notice = (
  body: unknown,
  moduleId = "m-notice",
  html = '<div class="notice">{{body}}</div>',
) => ({
  moduleId,
  slug: moduleId,
  displayName: moduleId,
  html,
  css: "",
  js: "",
  fields: [{ name: "body", kind: "richtext" as const }],
  contentValues: { body },
});

function page(
  layoutHtml: string,
  layoutBlocks: { blockName: string; modules: ReturnType<typeof notice>[] }[],
  content = notice("<p>Seite</p>", "m-page", "<p>{{body}}</p>"),
) {
  return composePageWithLayout({
    layoutHtml,
    layoutCss: "",
    layoutBlocks,
    templateHtml: '<caelo-slot name="content"></caelo-slot>',
    templateCss: "",
    blocks: [{ blockName: "content", modules: [content] }],
  });
}

const reasons = (out: { moduleFailures: readonly { reason: string }[] }) =>
  out.moduleFailures.map((f) => f.reason);

describe("slots and the page's open parts (#1732 review, round 3)", () => {
  it("2: a slot outside plain content refuses the plugin values of the module it holds", () => {
    for (const layout of [
      '<main><caelo-slot name="content"></caelo-slot></main><noscript><caelo-slot name="fallback"></caelo-slot></noscript>',
      '<main><caelo-slot name="content"></caelo-slot></main><select name="lang"><caelo-slot name="fallback"></caelo-slot></select>',
      '<main><caelo-slot name="content"></caelo-slot></main><svg><caelo-slot name="fallback"></caelo-slot></svg>',
    ]) {
      const out = page(layout, [{ blockName: "fallback", modules: [notice(owned(ESCAPE))] }]);
      expect(reasons(out)).toContain(refused(SLOT_PLACEMENT_RULE));
      expect(out.html).not.toContain("onerror=alert(1)>");
    }
    expect(
      frameReading('<noscript><caelo-slot name="a"></caelo-slot></noscript>').slotsOutside,
    ).toEqual(new Set(["a"]));
  });

  it("2: a slot in plain content keeps them", () => {
    const out = page(
      '<main><caelo-slot name="content"></caelo-slot></main><footer><caelo-slot name="foot"></caelo-slot></footer>',
      [{ blockName: "foot", modules: [notice(owned("<p>Fuß</p>"))] }],
    );
    expect(reasons(out)).toEqual([]);
    expect(out.html).toContain("<p>Fuß</p>");
  });

  it("4: a module that ends outside content refuses every plugin value on the page", () => {
    for (const open of ["<noscript>", "<svg><g>", "<select><option>a", "<!-- note", "<textarea>"]) {
      const out = page(
        '<main><caelo-slot name="content"></caelo-slot></main><footer><caelo-slot name="foot"></caelo-slot></footer>',
        [{ blockName: "foot", modules: [notice(owned("<p>Fuß</p>"))] }],
        { ...notice("x", "m-open", open), fields: [] },
      );
      expect(reasons(out)).toContain(refused(OPEN_MARKUP_RULE));
    }
  });

  it("4: a module without fields is read too; one its caller rendered is the caller's to place", () => {
    const layout =
      '<main><caelo-slot name="content"></caelo-slot></main><footer><caelo-slot name="foot"></caelo-slot></footer>';
    const foot = [{ blockName: "foot", modules: [notice(owned("<p>Fuß</p>"))] }];
    const { fields: _f, contentValues: _v, ...bare } = notice("x", "m-open", "<noscript>");
    expect(reasons(page(layout, foot, bare as ReturnType<typeof notice>))).toContain(
      refused(OPEN_MARKUP_RULE),
    );
    // The editor preview renders its page modules itself and passes the
    // verdict it worked out from their templates as `refusePluginValues`;
    // the composer never reads (or keeps) that per-page output.
    const rendered = { ...bare, rendered: true } as ReturnType<typeof notice>;
    expect(reasons(page(layout, foot, rendered))).toEqual([]);
  });

  it("4: so does a nested module that ends outside content", () => {
    const resolver: NestedRenderResolver = {
      getModule: (id) =>
        id === "m-child"
          ? { moduleId: "m-child", slug: "child", html: "<noscript>", css: "", js: "", fields: [] }
          : null,
      getContentInstance: (id) =>
        id === "ci-child" ? { id, moduleId: "m-child", values: {}, deletedAt: null } : null,
    };
    const out = composePagePreview({
      templateHtml: '<caelo-slot name="content"></caelo-slot>',
      templateCss: "",
      nestedModules: resolver,
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              ...notice(owned("<p>x</p>")),
              html: "{{>child}}<div>{{body}}</div>",
              fields: [
                { name: "child", kind: "module" },
                { name: "body", kind: "richtext" },
              ],
              contentValues: {
                child: { moduleId: "m-child", contentInstanceId: "ci-child" },
                body: owned("<p>x</p>"),
              },
            },
          ],
        },
      ],
    });
    expect(out.moduleFailures.map((f) => f.reason)).toContain(refused(OPEN_MARKUP_RULE));
  });

  it("renders a page without plugin values exactly as before", () => {
    const out = page(
      '<main><caelo-slot name="content"></caelo-slot></main><noscript><caelo-slot name="fallback"></caelo-slot></noscript>',
      [{ blockName: "fallback", modules: [notice("<p>core</p>")] }],
      { ...notice("x", "m-open", "<noscript>"), fields: [] },
    );
    expect(reasons(out)).toEqual([]);
    expect(out.html).toContain("<p>core</p>");
  });
});
