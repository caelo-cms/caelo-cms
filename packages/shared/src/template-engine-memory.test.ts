// SPDX-License-Identifier: MPL-2.0

/**
 * The template engine keeps nothing of what it renders, and long literal
 * text costs Mustache one token (searchVIU incident, 2026-11-01: the
 * Mustache parse cache held every page the admin or the generator ever
 * rendered, and the parser allocated a token per character of inline SVG).
 */

import { heapStats } from "bun:jsc";
import { describe, expect, it } from "bun:test";
import Mustache from "mustache";
import { renderTemplate, shieldLiteralText } from "./template-engine.js";

/** Render `html` the way the engine does: shielded, then the runs put back. */
function renderShielded(html: string, view: Record<string, unknown>): string {
  const runs: string[] = [];
  const shielded = shieldLiteralText(html, (text) => {
    runs.push(text);
    return `__RUN_${runs.length - 1}__`;
  });
  return Mustache.render(shielded, view).replace(
    /__RUN_(\d+)__/g,
    (_, i: string) => runs[Number(i)] ?? "",
  );
}

const LONG = "M10 20 C 30 40, 50 60, 70 80 Z ".repeat(20);

describe("shieldLiteralText", () => {
  const cases: [string, string, Record<string, unknown>][] = [
    [
      "a placeholder between long runs",
      `<svg><path d="${LONG}"/>{{title}}<p>${LONG}</p></svg>`,
      { title: "T" },
    ],
    [
      "a standalone comment line after a long line",
      `<p>${LONG}</p>\n  {{! note }}\n<p>{{title}}</p>`,
      { title: "T" },
    ],
    ["a standalone section line", `${LONG}\n{{#flag}}\n${LONG}\n{{/flag}}\nend`, { flag: true }],
    ["a long run inside a false section", `a{{#flag}}${LONG}{{/flag}}b`, { flag: false }],
    [
      "a long run inside an iterated section",
      `{{#items}}<li>${LONG}{{name}}</li>{{/items}}`,
      { items: [{ name: "x" }, { name: "y" }] },
    ],
    ["a triple mustache next to a long run", `{{{html}}}${LONG}{{&html}}`, { html: "<b>raw</b>" }],
    ["a long comment", `x{{! ${LONG} }}y`, {}],
    ["a whitespace-only long run", `{{#flag}}${" ".repeat(400)}{{/flag}}`, { flag: true }],
  ];
  for (const [name, html, view] of cases) {
    it(`renders exactly what Mustache renders: ${name}`, () => {
      expect(renderShielded(html, view)).toBe(Mustache.render(html, view));
    });
  }

  it("shields long runs and leaves tags, short text and a tag's inside alone", () => {
    const html = `<i>{{a}}</i>${LONG}{{${"b".repeat(300)}}}`;
    const kept: string[] = [];
    const out = shieldLiteralText(html, (t) => {
      kept.push(t);
      return "KEY";
    });
    expect(kept).toEqual([`</i>${LONG}`]);
    expect(out).toBe(`<i>{{a}}KEY{{${"b".repeat(300)}}}`);
  });

  it("leaves a template that changes the delimiters whole", () => {
    const html = `{{=<% %>=}}${LONG}<% name %>`;
    expect(shieldLiteralText(html, () => "KEY")).toBe(html);
  });
});

describe("renderTemplate keeps nothing it rendered", () => {
  it("Mustache's parse cache is off", () => {
    expect((Mustache as unknown as { templateCache: unknown }).templateCache).toBeUndefined();
  });

  it("puts a nested module back inside a shielded run", () => {
    const r = renderTemplate({
      html: `<section>${LONG}{{>featured}}${LONG}{{title}}</section>`,
      fields: [
        { name: "featured", kind: "module" },
        { name: "title", kind: "text" },
      ],
      contentValues: { featured: { moduleId: "m", contentInstanceId: "c" }, title: "T" },
      partials: { featured: "<p>nested {{not_a_tag}}</p>" },
    });
    expect(r.html).toBe(`<section>${LONG}<p>nested {{not_a_tag}}</p>${LONG}T</section>`);
    expect(r.missingSlots).toEqual([]);
  });

  it("renders 500 large modules without growing the live heap", () => {
    // One short line per path: nothing to shield, Mustache parses all of
    // it. The nested module is pasted in as a sentinel with a per-call
    // UUID, so Mustache sees a different template text on every call — as
    // it does for every module with a list, a nested module or a link.
    const svg = `<svg>${'<path d="M1 2 C 3 4, 5 6, 7 8 Z"/>\n'.repeat(300)}</svg>`;
    const render = (i: number) =>
      renderTemplate({
        html: `<section><h2>{{title}}</h2>${svg}{{>featured}}</section>`,
        fields: [
          { name: "title", kind: "text" },
          { name: "featured", kind: "module" },
        ],
        contentValues: {
          title: `Page ${i}`,
          featured: { moduleId: "m", contentInstanceId: "c" },
        },
        partials: { featured: `<p>Card ${i}</p>` },
      });
    render(0);
    Bun.gc(true);
    const before = heapStats();
    for (let i = 1; i <= 500; i += 1) render(i);
    Bun.gc(true);
    const after = heapStats();
    const grownMb =
      (after.heapSize + after.extraMemorySize - before.heapSize - before.extraMemorySize) / 1048576;
    // With the parse cache on, this kept 160 MB.
    expect(grownMb).toBeLessThan(8);
  });
});
