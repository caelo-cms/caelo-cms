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
import { fixtureData } from "./lists/list-fixtures.test.js";
import { createListRenderContext } from "./lists/resolve.js";
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

// A `list` field over the shipped `texts` / `links` types (epic #1107);
// the full list syntax lives in template-engine-lists.test.ts.
const lists = createListRenderContext(fixtureData()).forPage(null);
const uid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const texts = (...t: string[]) =>
  t.map((text, i) => ({ id: uid(i + 1), node: "text", values: { text } }));
const unstamp = (html: string) => html.replace(/ data-caelo-list-item="[^"]*"/g, "");

describe("renderTemplate — list section", () => {
  const listField: TemplateField = { name: "items", kind: "list", listType: "texts" };

  it("iterates a local list per entry", () => {
    const r = renderTemplate({
      html: "<ul>{{#items}}<li>{{text}}</li>{{/items}}</ul>",
      fields: [listField],
      contentValues: { items: texts("a", "b", "c") },
      lists,
    });
    expect(unstamp(r.html)).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
    expect(r.missingSlots).toEqual([]);
  });

  it("empty array renders as empty section, no missingSlots", () => {
    const r = renderTemplate({
      html: "<ul>{{#items}}<li>{{text}}</li>{{/items}}</ul>",
      fields: [listField],
      contentValues: { items: [] },
      lists,
    });
    expect(r.html).toBe("<ul></ul>");
    expect(r.missingSlots).toEqual([]);
  });

  it("a malformed entry becomes a loud raw section + tracks list-malformed", () => {
    const r = renderTemplate({
      html: "<ul>{{#items}}<li>{{text}}</li>{{/items}}</ul>",
      fields: [listField],
      contentValues: { items: [...texts("a"), { bogus: true }] },
      lists,
    });
    expect(r.html).toBe("<ul>{{#items}}<li>{{text}}</li>{{/items}}</ul>");
    expect(r.missingSlots).toEqual(["list-malformed:items[items[1]]"]);
  });

  it("links: label + link per entry (AC #1, list kind)", () => {
    const r = renderTemplate({
      html: '<nav>{{#nav_items}}<a href="{{link}}">{{label}}</a>{{/nav_items}}</nav>',
      fields: [{ name: "nav_items", kind: "list", listType: "links" }],
      contentValues: {
        nav_items: [
          { id: uid(1), node: "link", values: { label: "Docs", link: { href: "/docs" } } },
          { id: uid(2), node: "link", values: { label: "Blog", link: { href: "/blog" } } },
        ],
      },
      lists,
    });
    expect(unstamp(r.html)).toBe('<nav><a href="/docs">Docs</a><a href="/blog">Blog</a></nav>');
    expect(r.missingSlots).toEqual([]);
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
    // Structured twin of the comment, so a deploy can refuse it.
    expect(r.missingSlots).toEqual(["nested-renderer-unavailable:cards[0]"]);
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
    expect(r.missingSlots).toEqual(["nested-renderer-unavailable:hero"]);
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

describe("renderTemplate — empty single module field (#1041)", () => {
  const moduleField: TemplateField = { name: "after", kind: "module" };

  it("an unset module field renders empty and is not a failure", () => {
    const r = renderTemplate({
      html: "<aside>{{>after}}</aside>",
      fields: [moduleField],
      contentValues: {},
      partials: {},
    });
    expect(r.html).toBe("<aside></aside>");
    expect(r.missingSlots).toEqual([]);
  });

  it("an explicit null module field renders empty and is not a failure", () => {
    const r = renderTemplate({
      html: "<aside>{{>after}}</aside>",
      fields: [moduleField],
      contentValues: { after: null },
      partials: {},
    });
    expect(r.html).toBe("<aside></aside>");
    expect(r.missingSlots).toEqual([]);
  });

  it("a present non-ref value is still module-ref-malformed", () => {
    const r = renderTemplate({
      html: "<aside>{{>after}}</aside>",
      fields: [moduleField],
      contentValues: { after: { moduleId: "m" } },
    });
    expect(r.missingSlots).toEqual(["module-ref-malformed:after"]);
  });
});

describe("renderTemplate — literal braces in content are data (#1053)", () => {
  it("a list entry keeps a literal {{Page URL}}", () => {
    const r = renderTemplate({
      html: "<ul>{{#items}}<li>{{text}}</li>{{/items}}</ul>",
      fields: [{ name: "items", kind: "list", listType: "texts" }],
      contentValues: { items: texts("link.href = '{{Page URL}}';", "{{title}}") },
      lists,
    });
    expect(unstamp(r.html)).toBe("<ul><li>link.href = '{{Page URL}}';</li><li>{{title}}</li></ul>");
    expect(r.missingSlots).toEqual([]);
  });

  it("a list entry's label is never re-substituted as a placeholder", () => {
    const r = renderTemplate({
      html: '<nav>{{#nav}}<a href="{{link}}">{{label}}</a>{{/nav}}</nav>',
      fields: [{ name: "nav", kind: "list", listType: "links" }],
      contentValues: {
        nav: [
          {
            id: uid(1),
            node: "link",
            values: { label: "{{link}} {{Click URL}}", link: { href: "/x" } },
          },
        ],
      },
      lists,
    });
    expect(unstamp(r.html)).toBe('<nav><a href="/x">{{link}} {{Click URL}}</a></nav>');
  });

  it("rendered nested module HTML is pasted verbatim, not parsed again", () => {
    const r = renderTemplate({
      html: "<section>{{>body}}</section>",
      fields: [{ name: "body", kind: "module" }],
      contentValues: { body: { moduleId: "m", contentInstanceId: "c" } },
      partials: { body: "<code>{{Page URL}}</code>" },
    });
    expect(r.html).toBe("<section><code>{{Page URL}}</code></section>");
  });

  it("a top-level {{{body_html}}} value with braces still renders as written", () => {
    const r = renderTemplate({
      html: "<article>{{{body_html}}}</article>",
      fields: [{ name: "body_html", kind: "richtext" }],
      contentValues: { body_html: "<p><code>{{Page URL}}</code></p>" },
    });
    expect(r.html).toBe("<article><p><code>{{Page URL}}</code></p></article>");
  });

  it("a non-identifier tag in module HTML stays literal instead of rendering empty", () => {
    const r = renderTemplate({
      html: "<script>dataLayer.push({ url: '{{Page URL}}' })</script>",
      fields: [],
    });
    expect(r.html).toBe("<script>dataLayer.push({ url: '{{Page URL}}' })</script>");
    expect(r.missingSlots).toEqual([]);
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
      html: "<ul>{{ #items }}<li>{{ text }}</li>{{ /items }}</ul>",
      fields: [{ name: "items", kind: "list", listType: "texts" }],
      contentValues: { items: texts("a", "b") },
      lists,
    });
    expect(unstamp(r.html)).toBe("<ul><li>a</li><li>b</li></ul>");
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
  // A NON-list field used as a `{{#name}}…{{/name}}` section is a Mustache
  // CONDITIONAL, not a kind-mismatch — the old behaviour silently DROPPED
  // real scalar content (headings, body copy, an image, a nested module).
  it("renders a {{#scalar}} block when the text field has a value", () => {
    const r = renderTemplate({
      html: "<h1>{{#title}}{{title}}{{/title}}</h1>",
      fields: [{ name: "title", kind: "text" }],
      contentValues: { title: "Willkommen" },
    });
    expect(r.html).toBe("<h1>Willkommen</h1>");
    expect(r.missingSlots.some((s) => s.includes("kind-mismatch"))).toBe(false);
  });

  it("supports {{.}} inside a scalar conditional", () => {
    const r = renderTemplate({
      html: "<h2>{{#title}}{{.}}{{/title}}</h2>",
      fields: [{ name: "title", kind: "text" }],
      contentValues: { title: "Hallo" },
    });
    expect(r.html).toBe("<h2>Hallo</h2>");
  });

  it("drops a {{#scalar}} block only when the field is empty (conditional, not missing)", () => {
    const r = renderTemplate({
      html: "<p>{{#subtitle}}<span>{{subtitle}}</span>{{/subtitle}}</p>",
      fields: [{ name: "subtitle", kind: "text" }],
      contentValues: {},
    });
    expect(r.html).toBe("<p></p>");
    expect(r.missingSlots).toEqual([]);
  });

  it("wraps a scalar image field in a {{#image}} conditional", () => {
    const r = renderTemplate({
      html: '{{#photo}}<img src="{{photo}}" alt="rep">{{/photo}}',
      fields: [{ name: "photo", kind: "image" }],
      contentValues: { photo: "/_caelo/media/rep-photo" },
    });
    expect(r.html).toBe('<img src="/_caelo/media/rep-photo" alt="rep">');
  });

  it("kind-mismatch on {{>name}} against a list field", () => {
    const r = renderTemplate({
      html: "<aside>{{>items}}</aside>",
      fields: [{ name: "items", kind: "list", listType: "texts" }],
      contentValues: {},
    });
    const expected = "kind-mismatch:items expected=module actual=list";
    expect(r.html).toBe(`<aside><!-- caelo:missing reason=${expected} --></aside>`);
    expect(r.missingSlots).toContain(expected);
  });
});
