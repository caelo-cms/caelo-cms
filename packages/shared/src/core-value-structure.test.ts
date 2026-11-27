// SPDX-License-Identifier: MPL-2.0

/**
 * #1748 — a core value may not change the markup around its placeholder.
 * The rule (`core-value-structure.ts`) read against the HTML tokenizer and
 * tree builder, the engine's render failure for a stored value that breaks
 * (rendering stays as it was), and the write-time walks.
 */

import { describe, expect, it } from "bun:test";
import {
  coreValueProblemAt,
  describeValueBreaksMarkup,
  listEntryValueProblems,
  moduleValueProblems,
  parseValueBreaksMarkup,
  siteTextValueProblems,
  valueBreaksMarkupMarker,
  valueBreaksMarkupRepair,
} from "./core-value-structure.js";
import { fixtureData, fixtureLinkIndex, PAGE } from "./lists/list-fixtures.test.js";
import { createListRenderContext } from "./lists/resolve.js";
import { renderTemplate, type TemplateField } from "./template-engine.js";

/** The problem `value` has at the first `{{x}}` of `html`. */
const at = (html: string, value: string) => coreValueProblemAt(html, html.indexOf("{{x}}"), value);
const rule = (html: string, value: string) => at(html, value)?.rule ?? null;

/** The #1748 module: a site-texts list rendered into an inert `<template>` for a tool's script. */
const TOOL_TEXTS =
  "<section><template data-tool-tx>{{#ui_texts}}{{key}}={{text}}\n{{/ui_texts}}</template><footer>F</footer></section>";

describe("the structure rule for core values (#1748)", () => {
  it("refuses the #1748 value: `<?xml` inside a <template> starts a bogus comment", () => {
    const html = "<template data-tool-tx>{{x}}</template>";
    expect(at(html, "Die Datei sollte direkt mit <?xml beginnen.")).toEqual({
      rule: "processing-instruction",
      spelling: "<?xml beg",
      place: "element content inside <template>",
    });
  });

  it("refuses what closes, leaves open or starts markup outside the value", () => {
    const div = "<div>{{x}}</div>";
    expect(rule(div, "a</div>")).toBe("end-tag-div");
    expect(rule(div, "a</template>")).toBe("end-tag-template");
    expect(rule(div, "<b>bold")).toBe("unclosed-b");
    expect(rule(div, "<p>open")).toBe("unclosed-p");
    expect(rule(div, "x <b")).toBe("unfinished-tag");
    expect(rule(div, "a <!-- c --> b")).toBe("comment");
    expect(rule(div, "<!DOCTYPE html>")).toBe("doctype");
    expect(rule(div, "<![CDATA[x]]>")).toBe("markup-declaration");
    expect(rule(div, "<!x>")).toBe("markup-declaration");
    expect(rule(div, "x</ y")).toBe("bogus-end-tag");
  });

  it("refuses an element that closes the one the module places the value in", () => {
    expect(rule('<p class="lead">{{x}}</p>', "<p>Text</p>")).toBe("closes-p");
    expect(rule('<a href="/x">{{x}}</a>', '<a href="/y">z</a>')).toBe("closes-a");
    expect(rule("<h2>{{x}}</h2>", "<h3>z</h3>")).toBe("closes-h2");
    expect(rule("<ul><li>{{x}}</li></ul>", "a<li>b")).toBe("closes-li");
    // Markup that leaves SVG takes the module's SVG with it.
    expect(rule("<svg><text>{{x}}</text></svg>", "<p>x</p>")).toBe("closes-text");
  });

  it("refuses the end of raw text, RCDATA and comments, and a quote in its attribute", () => {
    expect(rule("<script>var a = '{{x}}';</script>", "</script><img src=x>")).toBe("ends-script");
    expect(rule("<script>var a = '{{x}}';</script>", "<!--<script>")).toBe("script-comment");
    expect(rule("<style>a::after{content:'{{x}}'}</style>", "</STYLE>")).toBe("ends-style");
    expect(rule("<title>{{x}}</title>", "a </title> b")).toBe("ends-title");
    expect(rule("<textarea>{{x}}</textarea>", "</textarea\n>")).toBe("ends-textarea");
    expect(rule("<!-- {{x}} -->", "a --> b")).toBe("ends-comment");
    expect(rule("<!--{{x}} -->", ">")).toBe("ends-comment");
    expect(rule('<a title="{{x}}">y</a>', 'say "hi"')).toBe("attribute-quote");
    expect(rule("<a title='{{x}}'>y</a>", "it's")).toBe("attribute-quote");
    expect(rule("<img alt={{x}}>", "a photo")).toBe("attribute-space");
    expect(rule("<img alt={{x}}>", "a>b")).toBe("attribute-end");
    expect(rule("<div {{x}}>", 'class="a> b')).toBe("ends-tag");
    expect(rule("<{{x}} class=a>", "h2>")).toBe("ends-tag-name");
  });

  it("allows entities, balanced inline markup and a `<` that starts no tag", () => {
    const div = "<div>{{x}}</div>";
    for (const ok of [
      "Tom &amp; Jerry",
      "a<br>b",
      "line</br>b",
      "<strong>x</strong>",
      "<em>a <b>b</b></em>",
      "a < b",
      "a <",
      "5<6",
      "&lt;?xml",
      "<p>a</p><p>b</p>",
      "<p>a<p>b</p>",
      "<ul><li>a<li>b</ul>",
      "<table><tr><td>a</td></tr></table>",
      '<a href="/y">z</a>',
    ]) {
      expect([ok, at(div, ok)]).toEqual([ok, null]);
    }
    // In the places that only their own end ends, markup is text.
    expect(at("<textarea>{{x}}</textarea>", "a </div> <b>")).toBeNull();
    expect(at("<title>{{x}}</title>", "<?xml")).toBeNull();
    expect(at('<a title="{{x}}">y</a>', "it's <b>")).toBeNull();
    expect(at("<a title='{{x}}'>y</a>", 'say "hi"')).toBeNull();
    expect(at("<div {{x}}>", 'class="a" id="b"')).toBeNull();
    expect(at("<svg><text>{{x}}</text></svg>", "<tspan>x</tspan>")).toBeNull();
    expect(at("<table><tr><td>{{x}}</td></tr></table>", "<b>x</b>")).toBeNull();
  });

  it("names the spelling, the place and the fix for a write's refusal", () => {
    const problem = at("<template>{{x}}</template>", "mit <?xml beginnen") as NonNullable<
      ReturnType<typeof at>
    >;
    expect(describeValueBreaksMarkup('"text" of entry e1 of list "ui_texts"', problem)).toBe(
      '"text" of entry e1 of list "ui_texts" holds `<?xml beg`: in element content inside <template> of the module HTML `<?xml beg` starts a bogus comment that hides what follows up to the next `>` (the module\'s own markup included). Write a < meant as text as &lt; (here `&lt;?xml beg`).',
    );
  });
});

describe("the engine records a breaking core value and renders it as before (#1748)", () => {
  const SITE_TEXTS = "00000000-0000-4000-8000-0000000000e1";
  const texts = (entries: Record<string, string>) =>
    createListRenderContext(
      fixtureData({
        lists: [
          {
            id: SITE_TEXTS,
            slug: "site-texts",
            name: "Site texts",
            typeSlug: "site-texts",
            items: Object.entries(entries).map(([key, text], i) => ({
              id: `00000000-0000-4000-9000-00000000090${i}`,
              node: "text",
              values: { key, text },
            })),
          },
        ],
      }),
    ).forPage(PAGE.home, { linkResolver: fixtureLinkIndex().forPage(PAGE.home) });
  const UI_TEXTS: TemplateField = {
    name: "ui_texts",
    kind: "list",
    listType: "site-texts",
    bind: "shared",
    list: `caelo:list/${SITE_TEXTS}`,
  };

  it("fails the #1748 module as value-breaks-markup, naming the list entry", () => {
    const r = renderTemplate({
      html: TOOL_TEXTS,
      fields: [UI_TEXTS],
      lists: texts({ ok: "Fertig", xml: "Die Datei sollte direkt mit <?xml beginnen." }),
      linkResolver: fixtureLinkIndex().forPage(PAGE.home),
    });
    // Rendered as it always was: the spot shows on staging as the preview shows it.
    expect(r.html).toContain("xml=Die Datei sollte direkt mit <?xml beginnen.");
    expect(r.missingSlots).toEqual([
      valueBreaksMarkupMarker(
        "ui_texts[00000000-0000-4000-9000-000000000901].text",
        "processing-instruction",
      ),
    ]);
  });

  it("checks module fields, defaults, site texts, conditionals and link paths", () => {
    const r = renderTemplate({
      html:
        '<h2 title="{{title}}">{{title}}</h2><div>{{body}}</div><p>{{deflt}}</p>' +
        "{{#flag}}<i>{{.}}</i>{{/flag}}" +
        '<a href="{{cta.href}}" aria-label="{{site_text.label}}">go</a>',
      fields: [
        { name: "title", kind: "text" },
        { name: "body", kind: "richtext" },
        { name: "deflt", kind: "text", default: "<p>x</p>" },
        { name: "flag", kind: "text" },
        { name: "cta", kind: "link" },
      ],
      contentValues: {
        title: 'Say "hi"',
        body: "<strong>fine</strong>",
        flag: "a</i>",
        cta: { href: '/x"y' },
      },
      lists: texts({ label: 'Go "now"' }),
      linkResolver: fixtureLinkIndex().forPage(PAGE.home),
    });
    expect(r.missingSlots.sort()).toEqual(
      [
        "value-breaks-markup:title:attribute-quote",
        "value-breaks-markup:deflt:closes-p",
        "value-breaks-markup:flag:end-tag-i",
        "value-breaks-markup:cta.href:attribute-quote",
        "value-breaks-markup:site_text.label:attribute-quote",
      ].sort(),
    );
  });

  it("records nothing for values that keep the markup around them", () => {
    const r = renderTemplate({
      html: '<h2 title="{{title}}">{{title}}</h2><div>{{body}}</div>',
      fields: [
        { name: "title", kind: "text" },
        { name: "body", kind: "richtext" },
      ],
      contentValues: { title: "Tom &amp; Jerry: a < b", body: "<p>a</p><p>b<br>c</p>" },
    });
    expect(r.missingSlots).toEqual([]);
  });
});

describe("the write-time walks (#1748)", () => {
  const fields = [
    { name: "title", kind: "text" },
    { name: "nav", kind: "list" },
  ];
  const HTML =
    '<h2>{{title}}</h2><ul>{{#nav}}<li><a href="{{link}}">{{label}}</a></li>{{/nav}}</ul>';
  const nav = (label: string, href = "/a") => [
    { id: "e1", node: "entry", values: { label, link: { href } } },
  ];

  it("finds the field and the list entry, with their paths", () => {
    const found = moduleValueProblems(HTML, fields, {
      title: "<b>x",
      nav: nav("a</li>", '/a"b'),
    });
    expect(found.map((p) => [p.path, p.problem.rule])).toEqual([
      [["title"], "unclosed-b"],
      [["nav", 0, "values", "label"], "end-tag-li"],
      [["nav", 0, "values", "link"], "attribute-quote"],
    ]);
  });

  it("lets a value the stored row already holds pass", () => {
    const stored = { title: "<b>x", nav: nav("a</li>") };
    expect(moduleValueProblems(HTML, fields, stored, stored)).toEqual([]);
    const next = moduleValueProblems(HTML, fields, { ...stored, title: "ok" }, stored);
    expect(next).toEqual([]);
  });

  it("checks a shared list's entries against a module that renders them", () => {
    const items = [{ id: "e1", node: "text", values: { key: "xml", text: "mit <?xml" } }];
    expect(
      listEntryValueProblems(TOOL_TEXTS, "ui_texts", items, ["items"]).map((p) => p.path),
    ).toEqual([["items", 0, "values", "text"]]);
    expect(listEntryValueProblems(TOOL_TEXTS, "ui_texts", items, ["items"], items)).toEqual([]);
  });

  it("checks the site texts a module reads by key", () => {
    const found = siteTextValueProblems(
      '<nav aria-label="{{site_text.label}}">{{site_text.more}}</nav>',
      new Map([
        ["label", 'Say "hi"'],
        ["more", "Mehr &raquo;"],
      ]),
    );
    expect(found.map((f) => [f.key, f.problem.rule])).toEqual([["label", "attribute-quote"]]);
  });
});

describe("the repair a Stage names for a breaking value (#1748)", () => {
  const MOD = 'module "tool"';

  it("names the tool for where the value comes from, the fix first", () => {
    const entry = valueBreaksMarkupRepair("ui_texts[e1].text:processing-instruction", MOD);
    expect(entry.tool).toBe("patch_list_items_many");
    expect(entry.hint).toStartWith("Write a < meant as text as &lt; (here `&lt;?`).");
    expect(entry.hint).toContain('"text" of entry e1 of list field "ui_texts"');
    expect(valueBreaksMarkupRepair("site_text.label:attribute-quote", MOD)).toMatchObject({
      tool: "patch_list_items_many",
    });
    expect(valueBreaksMarkupRepair("site_text.label:attribute-quote", MOD).hint).toStartWith(
      'Write the " as &quot;.',
    );
    expect(valueBreaksMarkupRepair("page.title:unclosed-b", MOD)).toMatchObject({
      tool: "update_pages_many",
    });
    expect(valueBreaksMarkupRepair("title:closes-p", MOD)).toMatchObject({
      tool: "set_content_instance_values_many",
    });
    expect(valueBreaksMarkupRepair("title:closes-p", MOD).hint).toContain(
      "the module already places it in a <p>",
    );
  });

  it("stays within a finding's hint, whatever the rule", () => {
    for (const rule of [
      "comment",
      "markup-declaration",
      "bogus-end-tag",
      "doctype",
      "end-tag-template",
      "unclosed-strong",
      "closes-h2",
      "unfinished-tag",
      "ends-script",
      "ends-title",
      "script-comment",
      "ends-comment",
      "attribute-space",
      "ends-tag",
      "breaks-structure",
    ]) {
      const { hint } = valueBreaksMarkupRepair(`ui_texts[${"e".repeat(36)}].text:${rule}`, MOD);
      expect([rule, hint.length <= 500]).toEqual([rule, true]);
    }
  });

  it("parses the marker it names", () => {
    expect(parseValueBreaksMarkup("ui_texts[e1].text:end-tag-div")).toEqual({
      field: "ui_texts[e1].text",
      rule: "end-tag-div",
    });
  });

  it("refuses a comment's own start and a quote that starts an unquoted value", () => {
    expect(rule("<!--{{x}} -->", "->")).toBe("ends-comment");
    expect(rule("<!-- a {{x}} -->", "a --!> b")).toBe("ends-comment");
    expect(at("<!-- a {{x}} -->", "> fine")).toBeNull();
    expect(rule("<img alt={{x}}>", '"a')).toBe("attribute-quote");
    expect(at("<img alt=a{{x}}>", "b's")).toBeNull();
    expect(at("<plaintext>{{x}}", "</plaintext>")).toBeNull();
  });
});
