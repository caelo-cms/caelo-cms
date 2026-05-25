// SPDX-License-Identifier: MPL-2.0

/**
 * Tier-1 unit tests for the shared template engine (Plan B per #71).
 *
 * Each test pins one of the §8.1 cases in the implementation plan and
 * states the exact expected output so a future regression points
 * directly at the affected branch.
 *
 * Failure-marker tests (kind-mismatch, *-malformed, module-ref-malformed,
 * field-not-declared) assert the literal `missingSlots` string the
 * chat-runner diag pass + editor missing-content surface read today —
 * any rename to the marker shape silently breaks those callers, so the
 * tests intentionally match strings, not regexes.
 */

import { describe, expect, it } from "bun:test";
import { renderTemplate, type TemplateField } from "./template-engine.js";

describe("renderTemplate — primitive substitution", () => {
  it("substitutes {{name}} with contentValues[name] (happy path)", () => {
    const r = renderTemplate({
      html: "<h1>{{title}}</h1>",
      fields: [{ name: "title", kind: "text" }],
      contentValues: { title: "Hello" },
    });
    expect(r.html).toBe("<h1>Hello</h1>");
    expect(r.missingSlots).toEqual([]);
  });

  it("contentValues beats field.default (per-placement wins)", () => {
    const r = renderTemplate({
      html: "<h1>{{title}}</h1>",
      fields: [{ name: "title", kind: "text", default: "D" }],
      contentValues: { title: "Override" },
    });
    expect(r.html).toBe("<h1>Override</h1>");
  });

  it("falls back to field.default when contentValues is absent", () => {
    const r = renderTemplate({
      html: "<h1>{{title}}</h1>",
      fields: [{ name: "title", kind: "text", default: "D" }],
      contentValues: {},
    });
    expect(r.html).toBe("<h1>D</h1>");
  });

  it("leaves unknown {{name}} as raw markers (loud-raw) and tracks field-not-declared", () => {
    const r = renderTemplate({
      html: "<h1>{{ghost}}</h1>",
      fields: [],
      contentValues: {},
    });
    expect(r.html).toBe("<h1>{{ghost}}</h1>");
    expect(r.missingSlots).toContain("field-not-declared:ghost");
  });

  it("leaves declared-but-empty {{name}} as raw markers without tracking missingSlots", () => {
    // A declared field with no contentValue and no default is the
    // operator's responsibility (still authoring), not a system-side
    // gap callers should warn about. Loud-raw in HTML, silent in the
    // structured channel.
    const r = renderTemplate({
      html: "<h1>{{title}}</h1>",
      fields: [{ name: "title", kind: "text" }],
      contentValues: {},
    });
    expect(r.html).toBe("<h1>{{title}}</h1>");
    expect(r.missingSlots).toEqual([]);
  });

  it("case-insensitive name match — {{ctaHref}} finds contentValues.ctahref", () => {
    const r = renderTemplate({
      html: "<h1>{{ctaHref}}</h1>",
      fields: [{ name: "ctahref", kind: "url" }],
      contentValues: { ctahref: "/x" },
    });
    expect(r.html).toBe("<h1>/x</h1>");
  });

  it("does NOT HTML-escape values (modules ARE the place raw HTML lives, §3.1)", () => {
    const r = renderTemplate({
      html: '<a href="{{u}}">x</a>',
      fields: [{ name: "u", kind: "url" }],
      contentValues: { u: "/docs?a=1&b=2" },
    });
    expect(r.html).toBe('<a href="/docs?a=1&b=2">x</a>');
  });
});

describe("renderTemplate — text-list section", () => {
  const textListField: TemplateField = { name: "items", kind: "text-list" };

  it("iterates with {{.}} per element", () => {
    const r = renderTemplate({
      html: "<ul>{{#items}}<li>{{.}}</li>{{/items}}</ul>",
      fields: [textListField],
      contentValues: { items: ["a", "b", "c"] },
    });
    expect(r.html).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
    expect(r.missingSlots).toEqual([]);
  });

  it("iterates with {{item}} alias per element", () => {
    const r = renderTemplate({
      html: "<ul>{{#items}}<li>{{item}}</li>{{/items}}</ul>",
      fields: [textListField],
      contentValues: { items: ["a", "b", "c"] },
    });
    expect(r.html).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
  });

  it("coerces numeric + boolean elements to strings", () => {
    const r = renderTemplate({
      html: "<ul>{{#items}}<li>{{.}}</li>{{/items}}</ul>",
      fields: [textListField],
      contentValues: { items: [1, true, "x"] },
    });
    expect(r.html).toBe("<ul><li>1</li><li>true</li><li>x</li></ul>");
  });

  it("empty array renders as empty section, no missingSlots", () => {
    const r = renderTemplate({
      html: "<ul>{{#items}}<li>{{.}}</li>{{/items}}</ul>",
      fields: [textListField],
      contentValues: { items: [] },
    });
    expect(r.html).toBe("<ul></ul>");
    expect(r.missingSlots).toEqual([]);
  });

  it("per-element malformed object becomes loud comment + tracks text-list-malformed", () => {
    const r = renderTemplate({
      html: "<ul>{{#items}}<li>{{.}}</li>{{/items}}</ul>",
      fields: [textListField],
      contentValues: { items: ["a", { bogus: true }, "c"] },
    });
    expect(r.html).toContain("<li>a</li>");
    expect(r.html).toContain("<li>c</li>");
    expect(r.html).toContain("<!-- caelo:missing reason=text-list-malformed items[1] -->");
    expect(r.missingSlots).toContain("text-list-malformed:items[1]");
  });
});

describe("renderTemplate — link-list section (AC #1)", () => {
  const linkListField: TemplateField = { name: "nav_items", kind: "link-list" };

  it("AC #1 verbatim fixture", () => {
    const r = renderTemplate({
      html: '<nav>{{#nav_items}}<a href="{{href}}">{{label}}</a>{{/nav_items}}</nav>',
      fields: [linkListField],
      contentValues: {
        nav_items: [
          { label: "Docs", href: "/docs" },
          { label: "Blog", href: "/blog" },
        ],
      },
    });
    expect(r.html).toBe('<nav><a href="/docs">Docs</a><a href="/blog">Blog</a></nav>');
    expect(r.html).not.toMatch(/\{\{[#/]/);
    expect(r.html).not.toMatch(/\{\{label/);
    expect(r.html).not.toMatch(/\{\{href/);
    expect(r.missingSlots).toEqual([]);
  });

  it("per-element malformed (missing href) becomes loud comment + tracks link-list-malformed", () => {
    const r = renderTemplate({
      html: '<nav>{{#nav_items}}<a href="{{href}}">{{label}}</a>{{/nav_items}}</nav>',
      fields: [linkListField],
      contentValues: {
        nav_items: [
          { label: "OK", href: "/a" },
          { label: "OK only" }, // missing href
        ],
      },
    });
    expect(r.html).toContain('<a href="/a">OK</a>');
    expect(r.html).toContain("<!-- caelo:missing reason=link-list-malformed nav_items[1] -->");
    expect(r.missingSlots).toContain("link-list-malformed:nav_items[1]");
  });
});

describe("renderTemplate — module-list section", () => {
  const moduleListField: TemplateField = { name: "cards", kind: "module-list" };

  it("renders each element from partials[<name>__<index>] in order", () => {
    const r = renderTemplate({
      html: "<ul>{{#cards}}<li>ignored</li>{{/cards}}</ul>",
      fields: [moduleListField],
      contentValues: {
        cards: [
          { moduleId: "m1", contentInstanceId: "c1" },
          { moduleId: "m2", contentInstanceId: "c2" },
        ],
      },
      partials: {
        cards__0: "<article>A</article>",
        cards__1: "<article>B</article>",
      },
    });
    expect(r.html).toBe("<ul><article>A</article><article>B</article></ul>");
    expect(r.html).not.toMatch(/\{\{[#/]/);
  });

  it("compose-path posture — no partials supplied → loud comment per element", () => {
    const r = renderTemplate({
      html: "<ul>{{#cards}}<li>ignored</li>{{/cards}}</ul>",
      fields: [moduleListField],
      contentValues: {
        cards: [{ moduleId: "m1", contentInstanceId: "c1" }],
      },
    });
    expect(r.html).toContain(
      "<!-- caelo:module-list cards needs recursive renderer (compose path) -->",
    );
    expect(r.html).not.toMatch(/\{\{[#/]/);
  });

  it("per-element malformed ref becomes loud comment + tracks module-list-malformed", () => {
    const r = renderTemplate({
      html: "<ul>{{#cards}}<li>x</li>{{/cards}}</ul>",
      fields: [moduleListField],
      contentValues: {
        cards: [{ moduleId: "m1", contentInstanceId: "c1" }, "not-a-ref"],
      },
      partials: { cards__0: "<article>A</article>" },
    });
    expect(r.html).toContain("<article>A</article>");
    expect(r.html).toContain("<!-- caelo:missing reason=module-list-malformed cards[1] -->");
    expect(r.missingSlots).toContain("module-list-malformed:cards[1]");
  });
});

describe("renderTemplate — single nested {{>name}}", () => {
  const moduleField: TemplateField = { name: "hero", kind: "module" };

  it("renders partials[<name>] inline", () => {
    const r = renderTemplate({
      html: "<aside>{{>hero}}</aside>",
      fields: [moduleField],
      contentValues: { hero: { moduleId: "m", contentInstanceId: "c" } },
      partials: { hero: "<h1>X</h1>" },
    });
    expect(r.html).toBe("<aside><h1>X</h1></aside>");
    expect(r.missingSlots).toEqual([]);
  });

  it("compose-path posture — no partial supplied → loud comment", () => {
    const r = renderTemplate({
      html: "<aside>{{>hero}}</aside>",
      fields: [moduleField],
      contentValues: { hero: { moduleId: "m", contentInstanceId: "c" } },
    });
    expect(r.html).toContain("<!-- caelo:module hero needs recursive renderer (compose path) -->");
  });

  it("malformed ref value becomes module-ref-malformed comment + tracks marker", () => {
    const r = renderTemplate({
      html: "<aside>{{>hero}}</aside>",
      fields: [moduleField],
      contentValues: { hero: "not-a-ref" },
    });
    expect(r.html).toContain("<!-- caelo:missing reason=module-ref-malformed hero -->");
    expect(r.missingSlots).toContain("module-ref-malformed:hero");
  });
});

describe("renderTemplate — loud-raw on unknown sections (AC #3)", () => {
  it("unknown {{#unknown}}…{{/unknown}} leaves raw markers + tracks field-not-declared", () => {
    const r = renderTemplate({
      html: "<p>{{#unknown}}x{{/unknown}}</p>",
      fields: [],
      contentValues: {},
    });
    expect(r.html).toBe("<p>{{#unknown}}x{{/unknown}}</p>");
    expect(r.missingSlots).toContain("field-not-declared:unknown");
  });

  it("unknown {{>partial}} leaves raw markers + tracks field-not-declared", () => {
    const r = renderTemplate({
      html: "<aside>{{>ghost}}</aside>",
      fields: [],
      contentValues: {},
    });
    expect(r.html).toBe("<aside>{{>ghost}}</aside>");
    expect(r.missingSlots).toContain("field-not-declared:ghost");
  });
});

describe("renderTemplate — whitespace tolerance in markers", () => {
  // The regexes allow surrounding whitespace inside the curly braces
  // (e.g. `{{ name }}`, `{{ #items }}`, `{{ > hero }}`). AI-authored
  // HTML usually emits tight markers, but a future extractor that
  // pretty-prints could regress silently — these tests pin behaviour
  // the regexes already support so any future tightening fails loudly.

  it("primitive {{ name }} (whitespace inside braces) substitutes normally", () => {
    const r = renderTemplate({
      html: "<h1>{{ title }}</h1>",
      fields: [{ name: "title", kind: "text" }],
      contentValues: { title: "Hello" },
    });
    expect(r.html).toBe("<h1>Hello</h1>");
  });

  it("section {{ #items }}…{{ /items }} (whitespace inside braces) iterates normally", () => {
    const r = renderTemplate({
      html: "<ul>{{ #items }}<li>{{ . }}</li>{{ /items }}</ul>",
      fields: [{ name: "items", kind: "text-list" }],
      contentValues: { items: ["a", "b"] },
    });
    expect(r.html).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("partial {{ > hero }} (whitespace inside braces) resolves normally", () => {
    const r = renderTemplate({
      html: "<aside>{{ > hero }}</aside>",
      fields: [{ name: "hero", kind: "module" }],
      contentValues: { hero: { moduleId: "m", contentInstanceId: "c" } },
      partials: { hero: "<h1>X</h1>" },
    });
    expect(r.html).toBe("<aside><h1>X</h1></aside>");
  });
});

describe("renderTemplate — failure-marker parity", () => {
  it("kind-mismatch on {{#name}} against a primitive field", () => {
    const r = renderTemplate({
      html: "<p>{{#title}}x{{/title}}</p>",
      fields: [{ name: "title", kind: "text" }],
      contentValues: {},
    });
    const expected = "kind-mismatch:title expected=module-list|text-list|link-list actual=text";
    expect(r.html).toBe(`<p><!-- caelo:missing reason=${expected} --></p>`);
    expect(r.missingSlots).toContain(expected);
  });

  it("kind-mismatch on {{>name}} against a list field", () => {
    const r = renderTemplate({
      html: "<aside>{{>items}}</aside>",
      fields: [{ name: "items", kind: "text-list" }],
      contentValues: {},
    });
    const expected = "kind-mismatch:items expected=module actual=text-list";
    expect(r.html).toBe(`<aside><!-- caelo:missing reason=${expected} --></aside>`);
    expect(r.missingSlots).toContain(expected);
  });
});
