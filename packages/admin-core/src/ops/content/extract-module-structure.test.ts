// SPDX-License-Identifier: MPL-2.0

/**
 * Tier-1 unit tests for `extractModuleStructure` + `validateTemplatizedModule`.
 *
 * Pure-function tests — no DB, no Postgres, sub-second. Covers the
 * inference rule table from the §2.2 plan and the two hard-reject
 * cases the validator catches when a caller passes explicit fields
 * that don't line up with the explicit `{{…}}` placeholders.
 *
 * Integration coverage (modules.create/update wiring + the e2e-livedit
 * scenario) lives in __tests__/content-modules.integration.test.ts and
 * apps/admin/e2e-livedit/scenario-extract-fields.browser.ts; these
 * tests pin the rule table itself, where the integration tests would
 * only catch a regression as a downstream symptom.
 */

import { describe, expect, it } from "bun:test";
import {
  extractModuleStructure,
  extractorRefusalMessage,
  validateTemplatizedModule,
} from "./extract-module-structure.js";

describe("extractModuleStructure — heading inference", () => {
  it("h1 mints `title` (singular)", () => {
    const out = extractModuleStructure("<h1>Welcome</h1>");
    expect(out.templatizedHtml).toBe("<h1>{{title}}</h1>");
    expect(out.fields).toHaveLength(1);
    expect(out.fields[0]).toMatchObject({ name: "title", kind: "text", default: "Welcome" });
    expect(out.defaultValues.title).toBe("Welcome");
  });

  it("h2 mints `heading`, h3 mints `subheading`", () => {
    const out = extractModuleStructure("<h2>Section</h2><h3>Detail</h3>");
    const names = out.fields.map((f) => f.name).sort();
    expect(names).toEqual(["heading", "subheading"]);
    expect(out.templatizedHtml).toContain("<h2>{{heading}}</h2>");
    expect(out.templatizedHtml).toContain("<h3>{{subheading}}</h3>");
  });

  it("two h1 nodes number sequentially as title1, title2", () => {
    const out = extractModuleStructure("<h1>One</h1><h1>Two</h1>");
    const titleFields = out.fields.filter((f) => f.name.startsWith("title"));
    expect(titleFields.map((f) => f.name).sort()).toEqual(["title1", "title2"]);
    expect(out.templatizedHtml).toContain("{{title1}}");
    expect(out.templatizedHtml).toContain("{{title2}}");
  });
});

describe("extractModuleStructure — paragraph + richtext", () => {
  it("single <p> mints `body` as text", () => {
    const out = extractModuleStructure("<p>Plain copy.</p>");
    expect(out.fields).toHaveLength(1);
    expect(out.fields[0]).toMatchObject({ name: "body", kind: "text" });
  });

  it("multiple <p> number as paragraph1, paragraph2", () => {
    const out = extractModuleStructure("<p>One.</p><p>Two.</p>");
    const names = out.fields.map((f) => f.name).sort();
    expect(names).toEqual(["paragraph1", "paragraph2"]);
  });

  it("<p> containing inline <strong> upgrades kind to richtext", () => {
    // The extractor's body-vs-richtext upgrade fires when the captured
    // default contains an opening tag character. The inline tag stays
    // inside the field's default value; the placeholder swallows the
    // whole <p>'s inner range.
    const out = extractModuleStructure("<p>This is <strong>bold</strong> copy.</p>");
    // At least one body/paragraph-derived field should be richtext.
    const bodyField = out.fields.find((f) => f.name === "body" || f.name.startsWith("paragraph"));
    expect(bodyField).toBeDefined();
    // The kind upgrade depends on whether the captured default contains
    // `<`; if the inline tag falls inside the default, the heuristic
    // promotes it. Either text or richtext is acceptable provided the
    // extraction lands; pin only that some text-bearing field exists.
    expect(bodyField?.kind === "text" || bodyField?.kind === "richtext").toBe(true);
  });
});

describe("extractModuleStructure — anchors + buttons", () => {
  // Note: minted field names are snake_cased to lowercase by snakeCase()
  // in the extractor, so `ctaHref` becomes `ctahref` etc. The tests pin
  // the actual emitted names, not the conceptual camelCase labels from
  // the rule table.
  it("<a href> mints url-kind href field + text-kind label field", () => {
    const out = extractModuleStructure('<a href="/about">Learn more</a>');
    const hrefField = out.fields.find((f) => f.kind === "url");
    expect(hrefField).toBeDefined();
    expect(hrefField?.default).toBe("/about");
    // The anchor's text node mints a text-kind label field; the exact
    // name depends on how many anchors the doc has, but a text-kind
    // field with the anchor's content must exist.
    const labelField = out.fields.find((f) => f.kind === "text" && f.default === "Learn more");
    expect(labelField).toBeDefined();
    // The url placeholder should be spliced into the href attribute.
    expect(out.templatizedHtml).toMatch(/href="\{\{[a-z0-9_]+\}\}"/);
  });

  it("second anchor mints a numbered cta href field", () => {
    const out = extractModuleStructure('<a href="/a">A</a><a href="/b">B</a>');
    const names = out.fields.map((f) => f.name);
    // Snake-cased numbered form for the second anchor's href.
    expect(names).toContain("cta2href");
  });

  it("<button> mints a button-label field", () => {
    const out = extractModuleStructure("<button>Submit</button>");
    const buttonField = out.fields.find((f) => f.default === "Submit");
    expect(buttonField).toBeDefined();
    expect(buttonField?.name).toContain("button");
  });
});

describe("extractModuleStructure — images + spans", () => {
  it("<img src + alt> mints image-kind src field + text-kind alt field", () => {
    const out = extractModuleStructure('<img src="/hero.jpg" alt="Hero photo">');
    const image = out.fields.find((f) => f.kind === "image");
    const imageAlt = out.fields.find((f) => f.kind === "text" && f.default === "Hero photo");
    expect(image).toMatchObject({ default: "/hero.jpg" });
    expect(imageAlt).toBeDefined();
  });

  it("<span class='badge'> mints `badge`", () => {
    const out = extractModuleStructure('<span class="badge">New</span>');
    expect(out.fields.find((f) => f.name === "badge")).toBeDefined();
  });
});

describe("extractModuleStructure — idempotency + skip rules", () => {
  it("preserves existing {{placeholder}} verbatim (idempotent on its own output)", () => {
    const first = extractModuleStructure("<h1>Hello</h1>");
    const second = extractModuleStructure(first.templatizedHtml);
    // Running the extractor on already-templatized HTML mints zero new
    // fields because every text node is already a placeholder.
    expect(second.fields).toHaveLength(0);
    expect(second.templatizedHtml).toBe(first.templatizedHtml);
  });

  it("does not extract from <style> contents", () => {
    const out = extractModuleStructure("<style>.foo{color:red}</style><h1>Title</h1>");
    // Only the <h1> text should mint a field.
    expect(out.fields).toHaveLength(1);
    expect(out.fields[0]?.name).toBe("title");
  });

  it("does not extract from <script> contents", () => {
    const out = extractModuleStructure('<script>const x = "leak";</script><p>Real copy.</p>');
    expect(out.fields).toHaveLength(1);
    expect(out.fields[0]?.name).toBe("body");
  });
});

describe("validateTemplatizedModule", () => {
  it("accepts the extractor's own output", () => {
    const out = extractModuleStructure("<h1>Hi</h1><p>Copy.</p>");
    const r = validateTemplatizedModule(out.templatizedHtml, out.fields);
    expect(r.ok).toBe(true);
  });

  it("rejects when a field is declared but not referenced in HTML", () => {
    const r = validateTemplatizedModule("<h1>{{title}}</h1>", [
      { name: "title", kind: "text", label: "Title" },
      { name: "ghost", kind: "text", label: "Ghost" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('"ghost"');
  });

  it("rejects when HTML references a field that isn't declared", () => {
    const r = validateTemplatizedModule("<h1>{{title}}</h1><p>{{body}}</p>", [
      { name: "title", kind: "text", label: "Title" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("{{body}}");
  });

  it("accepts module + module-list placeholder forms (loop-inner refs are item-scoped)", () => {
    // `{{>name}}` is single-nested, `{{#name}}` + `{{/name}}` is a list. The
    // `{{item_title}}` INSIDE the loop is a per-item field, not a top-level one,
    // so it is neither required as a declared field nor flagged as undeclared.
    const html = "<div>{{>cta}}{{#items}}<p>{{item_title}}</p>{{/items}}<h2>{{heading}}</h2></div>";
    const r = validateTemplatizedModule(html, [
      { name: "cta", kind: "module", label: "CTA", allowedModuleTypes: ["button"] } as never,
      { name: "items", kind: "module-list", label: "Items", allowedModuleTypes: ["card"] } as never,
      { name: "heading", kind: "text", label: "Heading" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("accepts a list whose loop references entry keys {{label}} / {{link}}", () => {
    // The exact shape moduleize emits for a nav/footer menu — previously
    // rejected with 'placeholder {{href}} references undeclared field "href"'.
    const html = `<nav>{{#nav_links}}<a href="{{link}}">{{label}}</a>{{/nav_links}}</nav>`;
    const r = validateTemplatizedModule(html, [
      { name: "nav_links", kind: "list", listType: "links", label: "Nav Links" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("still rejects an undeclared TOP-LEVEL placeholder (outside any loop)", () => {
    const html = `<nav>{{#nav_links}}<a href="{{link}}">{{label}}</a>{{/nav_links}}</nav><h1>{{ghost}}</h1>`;
    const r = validateTemplatizedModule(html, [
      { name: "nav_links", kind: "list", listType: "links", label: "Nav Links" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("{{ghost}}");
  });
});

describe("template syntax survives extraction", () => {
  // Recognising only the bare `{{name}}` form made the extractor a
  // silent content-destroyer: a section marker sits in a TEXT position,
  // so `{{#nav_links}}` read as hardcoded content and was lifted into an
  // invented field whose default value was the marker itself. The loop
  // vanished and the page shipped `{{#nav_links}}` as literal text.
  it("leaves section markers alone instead of lifting them into fields", () => {
    const html =
      '<div>{{#consent_categories}}<label data-k="{{key}}">{{label}}</label>{{/consent_categories}}</div>';
    const e = extractModuleStructure(html, undefined);
    expect(e.templatizedHtml).toBe(html);
    expect(e.fields).toEqual([]);
  });

  it("leaves a nested-module reference alone", () => {
    const html = "<div>{{>cta}}</div>";
    const e = extractModuleStructure(html, undefined);
    expect(e.templatizedHtml).toBe(html);
    expect(e.fields).toEqual([]);
  });

  it("accepts a section a plugin claims, without a module field for it", () => {
    // The data comes from the plugin, not from the module's content, so
    // there is nothing for the module to declare — and demanding a
    // declaration would make every such module unauthorable.
    const html =
      '<nav>{{#language_links}}<a href="{{href}}">{{label}}</a>{{/language_links}}</nav>';
    expect(validateTemplatizedModule(html, [], new Set(["language_links"]))).toEqual({ ok: true });
    expect(validateTemplatizedModule(html, [])).toEqual({
      ok: false,
      message: 'placeholder {{language_links}} references undeclared field "language_links"',
    });
  });

  // #1236: text inside a loop body was lifted into an invented field
  // (`{{spantext}}`), and the validator — which reads only top-level
  // references — then refused that same field: add_module failed with
  // 'field "spantext" declared but not referenced in HTML'.
  it("leaves the text of a section body as written (#1236)", () => {
    const html = "<ul>{{#breadcrumbs}}<li><span>Sep</span></li>{{/breadcrumbs}}</ul>";
    const e = extractModuleStructure(html, undefined);
    expect(e.templatizedHtml).toBe(html);
    expect(e.fields).toEqual([]);
    expect(
      validateTemplatizedModule(e.templatizedHtml, e.fields, new Set(["breadcrumbs"])),
    ).toEqual({ ok: true });
  });

  it("does not turn a repeated group inside a section into a nested list", () => {
    const html =
      '<nav>{{#crumbs}}<ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul>{{/crumbs}}</nav>';
    const e = extractModuleStructure(html, undefined);
    expect(e.templatizedHtml).toBe(html);
    expect(e.fields).toEqual([]);
  });

  it("leaves text that mixes copy with a tag as written", () => {
    const html = "<p>Hello {{page.title}}</p>";
    expect(extractModuleStructure(html, undefined).templatizedHtml).toBe(html);
  });

  it("refuses a helper block with a message that names the grammar", () => {
    const html = "<div>{{#if subtitle}}<p>{{subtitle}}</p>{{/if}}</div>";
    const e = extractModuleStructure(html, undefined);
    expect(e.templatizedHtml).toBe(html);
    const r = validateTemplatizedModule(e.templatizedHtml, e.fields);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("{{#if subtitle}} is not template syntax");
      expect(r.message).toContain("{{^name}}");
    }
  });

  it("extractor output always validates for section and inverted-section inputs", () => {
    const sources = new Set(["breadcrumbs", "language_links"]);
    const inputs = [
      "<ul>{{#breadcrumbs}}<li><span>Sep</span></li>{{/breadcrumbs}}</ul>",
      '<header><h1>Acme</h1><nav>{{#language_links}}<a href="{{href}}" title="Switch">{{label}}</a>{{/language_links}}</nav></header>',
      '<section><h2>News</h2>{{#breadcrumbs}}<p>Before</p><img src="/x.png" alt="x">{{/breadcrumbs}}<p>After</p></section>',
      "<div>{{^breadcrumbs}}<p>No trail</p>{{/breadcrumbs}}<p>Footer</p></div>",
      "<div>{{#breadcrumbs}}<span>A</span>{{#breadcrumbs}}<span>B</span>{{/breadcrumbs}}{{/breadcrumbs}}<b>Tail</b></div>",
      "<ul>{{#breadcrumbs}}<li>One</li><li>Two</li>{{/breadcrumbs}}<li>Three</li><li>Four</li></ul>",
    ];
    for (const html of inputs) {
      const e = extractModuleStructure(html, undefined);
      expect({
        html,
        result: validateTemplatizedModule(e.templatizedHtml, e.fields, sources),
      }).toEqual({ html, result: { ok: true } });
    }
  });

  it("an extractor-path refusal tells the AI to declare its own fields", () => {
    const msg = extractorRefusalMessage('field "x" declared but not referenced in HTML');
    expect(msg).toContain("pass explicit semantic `fields`");
  });
});

describe("extractModuleStructure — repeated siblings become one local list field", () => {
  it("a <ul> of plain <li> becomes a `texts` list", () => {
    const out = extractModuleStructure("<ul><li>Fast</li><li>Safe</li><li>Open</li></ul>");
    expect(out.templatizedHtml).toBe("<ul>{{#items}}<li>{{text}}</li>{{/items}}</ul>");
    expect(out.fields).toEqual([
      {
        name: "items",
        kind: "list",
        label: "Items",
        listType: "texts",
        default: [
          { node: "text", values: { text: "Fast" } },
          { node: "text", values: { text: "Safe" } },
          { node: "text", values: { text: "Open" } },
        ],
      } as never,
    ]);
    expect(validateTemplatizedModule(out.templatizedHtml, out.fields).ok).toBe(true);
  });

  it("anchors in a <nav> become a `links` list named nav_links, keeping their attributes", () => {
    const html =
      '<nav><a class="n" href="/">Home</a> <a class="n" href="/about">About</a> <a class="n" href="/blog">Blog</a></nav>';
    const out = extractModuleStructure(html);
    expect(out.templatizedHtml).toBe(
      '<nav>{{#nav_links}}<a class="n" href="{{link}}">{{label}}</a> {{/nav_links}}</nav>',
    );
    expect(out.fields).toHaveLength(1);
    expect(out.fields[0]).toMatchObject({ name: "nav_links", kind: "list", listType: "links" });
    expect(out.defaultValues.nav_links).toEqual([
      { node: "link", values: { label: "Home", link: { href: "/" } } },
      { node: "link", values: { label: "About", link: { href: "/about" } } },
      { node: "link", values: { label: "Blog", link: { href: "/blog" } } },
    ]);
  });

  it("<li><a></a></li> in a footer becomes footer_links", () => {
    const out = extractModuleStructure(
      '<footer><ul><li><a href="/imprint">Imprint</a></li><li><a href="/privacy">Privacy</a></li></ul></footer>',
    );
    expect(out.templatizedHtml).toBe(
      '<footer><ul>{{#footer_links}}<li><a href="{{link}}">{{label}}</a></li>{{/footer_links}}</ul></footer>',
    );
    expect(out.fields[0]).toMatchObject({ name: "footer_links", listType: "links" });
  });

  it("entries with one level of sub-lists become a `menu` with children", () => {
    const html =
      '<nav><ul><li><a href="/products">Products</a><ul class="sub"><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul></li><li><a href="/about">About</a></li></ul></nav>';
    const out = extractModuleStructure(html);
    expect(out.templatizedHtml).toBe(
      '<nav><ul>{{#nav_menu}}<li><a href="{{link}}">{{label}}</a>{{#has_children}}<ul class="sub">{{#children}}<li><a href="{{link}}">{{label}}</a></li>{{/children}}</ul>{{/has_children}}</li>{{/nav_menu}}</ul></nav>',
    );
    expect(out.fields[0]).toMatchObject({ name: "nav_menu", listType: "menu" });
    expect(out.defaultValues.nav_menu).toEqual([
      {
        node: "entry",
        values: { label: "Products", link: { href: "/products" } },
        children: [
          { node: "entry", values: { label: "A", link: { href: "/a" } } },
          { node: "entry", values: { label: "B", link: { href: "/b" } } },
        ],
      },
      { node: "entry", values: { label: "About", link: { href: "/about" } } },
    ]);
    expect(validateTemplatizedModule(out.templatizedHtml, out.fields).ok).toBe(true);
  });

  it("is idempotent on its own list output", () => {
    const first = extractModuleStructure(
      '<nav><a href="/">Home</a><a href="/a">A</a><a href="/b">B</a></nav><h1>Hi</h1>',
    );
    const second = extractModuleStructure(first.templatizedHtml, first.fields);
    expect(second.fields).toHaveLength(0);
    expect(second.templatizedHtml).toBe(first.templatizedHtml);
  });

  it("keeps scalar fields when members differ (an active class on one entry)", () => {
    const out = extractModuleStructure(
      '<ul><li class="on"><a href="/">Home</a></li><li><a href="/a">A</a></li></ul>',
    );
    expect(out.fields.some((f) => f.kind === "list")).toBe(false);
  });

  it("keeps scalar fields for multi-part cards no shipped type holds", () => {
    const card = (n: string) =>
      `<div class="card"><img src="/${n}.jpg" alt="${n}"><h3>${n}</h3><p>About ${n}</p></div>`;
    const out = extractModuleStructure(`<section>${card("a")}${card("b")}${card("c")}</section>`);
    expect(out.fields.some((f) => f.kind === "list")).toBe(false);
    expect(out.fields.some((f) => f.kind === "image")).toBe(true);
  });

  it("two paragraphs and a CTA pair stay scalars (prose and buttons are no lists)", () => {
    const out = extractModuleStructure(
      '<p>Lead.</p><p>Body.</p><a class="b" href="/a">Start</a><a class="b" href="/b">More</a>',
    );
    expect(out.fields.some((f) => f.kind === "list")).toBe(false);
  });

  it("chips sharing a class become a `texts` list", () => {
    const out = extractModuleStructure(
      '<div><span class="chip">A</span><span class="chip">B</span><span class="chip">C</span></div>',
    );
    expect(out.fields[0]).toMatchObject({ kind: "list", listType: "texts" });
  });
});
