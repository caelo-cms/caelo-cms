// SPDX-License-Identifier: MPL-2.0

/**
 * #1748 — a core value may not change the markup around its placeholder.
 * The rule (`core-value-structure.ts`) read against the HTML tokenizer and
 * tree builder, the engine's render failure for a stored value that breaks
 * (rendering stays as it was), and the write-time walks.
 */

import { describe, expect, it } from "bun:test";
import {
  describeValueBreaksMarkup,
  parseValueBreaksMarkup,
  valueBreaksMarkupMarker,
  valueBreaksMarkupRepair,
} from "./core-value-messages.js";
import { coreValueProblemAt } from "./core-value-structure.js";
import {
  listEntryValueProblems,
  moduleValueProblems,
  siteTextValueProblems,
} from "./core-value-writes.js";
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
    expect(rule("<a title='{{x}}'>y</a>", "it's")).toBe("attribute-apostrophe");
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

describe("#1748 review: what the value meets around it", () => {
  it("reads its own text elements as text, as the browser's tree builder makes the tokenizer read them", () => {
    expect(at("<div>{{x}}</div>", "<textarea></div></textarea>")).toBeNull();
    expect(at("<div>{{x}}</div>", '<style>a::after{content:"</div><!--"}</style>')).toBeNull();
    expect(at("<div>{{x}}</div>", "<script>if (a<b) x = '</div>';</script>")).toBeNull();
    expect(rule("<div>{{x}}</div>", "<textarea>x")).toBe("unclosed-textarea");
  });

  it("counts the template's text after the value: it can complete what the value starts", () => {
    expect(rule("<textarea>{{x}}>still inside</textarea>", "</textarea")).toBe("ends-textarea");
    expect(at("<textarea>{{x}}still inside</textarea>", "</textarea")).toBeNull();
    expect(rule("<!-- a {{x}}> b -->", "--")).toBe("ends-comment");
    expect(rule("<p>{{x}}b</p>", "a <")).toBe("unfinished-tag");
    expect(at("<p>{{x}} b</p>", "a <")).toBeNull();
  });

  it("checks a module field only where its section renders", () => {
    const fields: TemplateField[] = [
      { name: "show", kind: "boolean" },
      { name: "body", kind: "richtext" },
    ];
    const html = "{{#show}}<p>{{body}}</p>{{/show}}";
    const hidden = renderTemplate({
      html,
      fields,
      contentValues: { show: false, body: "<p>T</p>" },
    });
    expect(hidden.missingSlots).toEqual([]);
    const shown = renderTemplate({ html, fields, contentValues: { show: true, body: "<p>T</p>" } });
    expect(shown.missingSlots).toEqual(["value-breaks-markup:body:closes-p"]);
  });

  it("checks a `{{&field}}` inside a list's entries, at render and at write", () => {
    const html = "{{#nav}}<div>{{&body}}</div>{{/nav}}";
    const fields: TemplateField[] = [
      { name: "nav", kind: "list", listType: "texts" },
      { name: "body", kind: "richtext" },
    ];
    const r = renderTemplate({
      html,
      fields,
      contentValues: {
        body: "</div>",
        nav: [{ id: "00000000-0000-4000-9000-000000000001", node: "text", values: { text: "a" } }],
      },
      lists: createListRenderContext(fixtureData()).forPage(PAGE.home, {
        linkResolver: fixtureLinkIndex().forPage(PAGE.home),
      }),
      linkResolver: fixtureLinkIndex().forPage(PAGE.home),
    });
    expect(r.missingSlots).toEqual(["value-breaks-markup:body:end-tag-div"]);
    expect(moduleValueProblems(html, fields, { body: "</div>" }).map((p) => p.path)).toEqual([
      ["body"],
    ]);
  });
});

describe("#1748 review, round 2", () => {
  it("counts the template's text before the value: the value can complete what it started", () => {
    expect(rule("<!-- --{{x}}hidden -->", ">")).toBe("ends-comment");
    expect(rule("<!--{{x}} -->", ">")).toBe("ends-comment");
    expect(at("<!-- -{{x}} -->", "x>")).toBeNull();
    expect(rule("<textarea></text{{x}}</textarea>", "area>")).toBe("ends-textarea");
    expect(at("<textarea>a{{x}}</textarea>", "/textarea")).toBeNull();
  });

  it("refuses a value that takes an element around it off the stack, not only the innermost", () => {
    expect(rule('<form><div>{{x}}</div><input name="email"></form>', "<form></form>")).toBe(
      "end-tag-form",
    );
    expect(at("<form><div>{{x}}</div></form>", "<b>x</b>")).toBeNull();
  });

  it("checks a list entry only at the tags that read the entry, not at a `{{&field}}`", () => {
    const items = [{ id: "e1", node: "text", values: { body: "<p>Text</p>", text: "a" } }];
    expect(
      listEntryValueProblems("{{#nav}}<p>{{&body}}</p>{{/nav}}", "nav", items, ["items"]),
    ).toEqual([]);
  });
});

describe("#1748 review, round 3", () => {
  it("reads misnested formatting with the tree builder: it leaks into the module's markup", () => {
    expect(rule("<div>{{x}} suffix</div>", "<b><i>x</b>")).toBe("unclosed-i");
    expect(at("<div>{{x}} suffix</div>", "<b><i>x</i></b>")).toBeNull();
  });

  it("checks letters in raw text and comments, where the template's text can complete an end", () => {
    expect(rule("<textarea></text{{x}}>hidden</textarea>", "area")).toBe("ends-textarea");
    expect(at("<textarea>{{x}}</textarea>", "area")).toBeNull();
    expect(at("<p>{{x}}</p>", "plain words")).toBeNull();
  });

  it("lets a dash after the comment's own start pass", () => {
    expect(at("<!--{{x}} note -->", "-")).toBeNull();
    expect(rule("<!--{{x}} note -->", "->")).toBe("ends-comment");
  });
});

describe("#1748 review, round 4", () => {
  it("refuses an end split over two values next to each other", () => {
    const html = "<textarea>{{a}}{{x}}</textarea>";
    const a = (v: string) => coreValueProblemAt(html, html.indexOf("{{a}}"), v)?.rule ?? null;
    const b = (v: string) => coreValueProblemAt(html, html.indexOf("{{x}}"), v)?.rule ?? null;
    expect(a("</text")).toBe("ends-textarea");
    expect(b("area>outside")).toBe("ends-textarea");
    expect(a("plain")).toBeNull();
    expect(b(" more")).toBeNull();
    const comment = "<!-- {{a}}{{x}} -->";
    expect(coreValueProblemAt(comment, comment.indexOf("{{a}}"), "x-")?.rule).toBe("ends-comment");
    expect(coreValueProblemAt(comment, comment.indexOf("{{x}}"), "->x")?.rule).toBe("ends-comment");
    // A space between two titles, which ends nothing.
    const title = "<title>{{a}} {{x}}</title>";
    expect(coreValueProblemAt(title, title.indexOf("{{x}}"), "Seite")).toBeNull();
  });

  it("keeps a self-closing tag self-closing", () => {
    expect(rule("<svg><g {{x}}/><circle/></svg>", 'class="a" id=x')).toBe("tag-self-closing");
    expect(at("<svg><g {{x}}/><circle/></svg>", 'class="a" id="x"')).toBeNull();
    expect(rule("<div {{x}}>y</div>", 'title="a>b')).toBe("ends-tag");
  });

  it("checks a parent entry's value only where it renders: its own depth, and a child's that lacks the key", () => {
    const html =
      '{{#nav}}<div>{{label}}</div>{{#children}}<a title="{{label}}">child</a>{{/children}}{{/nav}}';
    const entry = (label: string, children?: { id: string; label?: string }[]) => ({
      id: "p1",
      node: "entry",
      values: { label },
      ...(children
        ? {
            children: children.map((c) => ({
              id: c.id,
              node: "entry",
              values: c.label === undefined ? {} : { label: c.label },
            })),
          }
        : {}),
    });
    expect(
      listEntryValueProblems(html, "nav", [entry('Say "hi"', [{ id: "c1", label: "Child" }])], []),
    ).toEqual([]);
    expect(
      listEntryValueProblems(html, "nav", [entry('Say "hi"', [{ id: "c1" }])], []).map(
        (p) => p.problem.rule,
      ),
    ).toEqual(["attribute-quote"]);
    expect(
      listEntryValueProblems(html, "nav", [entry("ok", [{ id: "c1", label: 'Say "hi"' }])], []).map(
        (p) => p.path,
      ),
    ).toEqual([[0, "children", 0, "values", "label"]]);
  });
});

describe("#1748 review, round 5", () => {
  it("checks a tag's attributes whatever the value holds", () => {
    expect(rule("<svg><g {{x}}/><circle/></svg>", "id=x")).toBe("tag-self-closing");
    expect(at("<svg><g {{x}}/><circle/></svg>", "hidden")).toBeNull();
  });

  it("names the quote that ends the attribute, in the marker and in its repair", () => {
    expect(rule("<a title='{{x}}'>y</a>", "it's")).toBe("attribute-apostrophe");
    expect(valueBreaksMarkupRepair("title:attribute-apostrophe", 'module "m"').hint).toStartWith(
      "Write the ' as &#39;.",
    );
    expect(valueBreaksMarkupRepair("title:attribute-quote", 'module "m"').hint).toStartWith(
      'Write the " as &quot;.',
    );
  });
});

describe("#1748 review, round 6", () => {
  it("lets only a letter start a tag's name right after the template's `<`", () => {
    expect(rule("<div><{{x}}>hidden</div><footer>F</footer>", "!--note")).toBe("ends-tag-name");
    expect(rule("<div><{{x}}>hidden</div>", "?xml")).toBe("ends-tag-name");
    expect(at("<div><{{x}} class=a>hidden</div>", "h2")).toBeNull();
  });

  it("reads text elements as text again inside an HTML integration point of SVG", () => {
    expect(
      at(
        "<div>{{x}}</div>",
        "<svg><foreignObject><textarea></div></textarea></foreignObject></svg>",
      ),
    ).toBeNull();
  });
});

describe("#1748 review, round 7", () => {
  it("refuses markup right inside a table's structure, where the parser reads it against the table", () => {
    const html = "<div><table>{{x}}<tr><td>After</td></tr></table></div>";
    expect(rule(html, "<table></table>")).toBe("markup-in-table");
    expect(at(html, "plain text")).toBeNull();
    expect(at("<table><tr><td>{{x}}</td></tr></table>", "<table></table>")).toBeNull();
  });

  it("leaves SVG at an HTML breakout tag before it reads text elements", () => {
    expect(at("<div>{{x}}</div>", "<svg><p><textarea></div></textarea></p></svg>")).toBeNull();
  });

  it("checks a value as plain content too where a section can change its reading", () => {
    const html = "<div>{{#show}}<textarea>{{/show}}{{x}}{{#show}}</textarea>{{/show}}</div>";
    expect(rule(html, "</div>")).toBe("end-tag-div");
    expect(at(html, "Text &amp; more")).toBeNull();
  });
});
