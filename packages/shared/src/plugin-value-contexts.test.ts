// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 (docs/dev/external-plugin-brokers.md §4.5) — a plugin's value is
 * checked against where the module puts it: escaped in text and in a
 * non-URL attribute, held to the link rule in a URL attribute, refused in
 * an event handler, a `style` attribute, `srcdoc` and a `<script>` or
 * `<style>` body. A core value in the same places renders exactly as it
 * always has.
 */

import { describe, expect, it } from "bun:test";
import { fixtureData, PAGE } from "./lists/list-fixtures.test.js";
import { type PluginValueOrigin, pluginValue, richtextProblem } from "./lists/plugin-values.js";
import { createListRenderContext } from "./lists/resolve.js";
import { placeholderContexts } from "./template-contexts.js";
import { renderTemplate, type TemplateField } from "./template-engine.js";

const ORIGIN: PluginValueOrigin = {
  plugin: "international-site",
  point: "content-variants",
  address: "layout:header:0/title",
  type: "text",
};
const TITLE = "JavaScript: Grundlagen";
const owned = (value: unknown, type = "text") => pluginValue({ ...ORIGIN, type }, value);
const refusal = (rule: string) =>
  `plugin-value-refused:international-site.content-variants.layout:header:0/title:${rule}`;

function render(
  html: string,
  value: unknown,
  fields: TemplateField[] = [{ name: "title", kind: "text" }],
) {
  return renderTemplate({ html, fields, contentValues: { title: value } });
}

describe("a plugin's value where the module puts it (#1729, §4.5)", () => {
  it("renders 'JavaScript: Grundlagen' as text and in a quoted title", () => {
    const r = render(`<h1>{{title}}</h1><a title="{{title}}" href="/x">x</a>`, owned(TITLE));
    expect(r.html).toBe(`<h1>${TITLE}</h1><a title="${TITLE}" href="/x">x</a>`);
    expect(r.missingSlots).toEqual([]);
    const escaped = render(`<p>{{title}}</p><i title='{{title}}'></i>`, owned(`a "b" <c> & 'd'`));
    expect(escaped.html).toBe(
      `<p>a &quot;b&quot; &lt;c&gt; &amp; &#39;d&#39;</p><i title='a &quot;b&quot; &lt;c&gt; &amp; &#39;d&#39;'></i>`,
    );
  });

  it("refuses the same value in an href, and keeps the placeholder raw", () => {
    // The link rule stops it at its space; without one, at its scheme.
    const r = render(`<a href="{{title}}">x</a>`, owned(TITLE));
    expect(r.missingSlots).toEqual([refusal("url-characters")]);
    expect(r.html).toBe(`<a href="{{title}}">x</a>`);
    expect(render(`<a href="{{title}}">x</a>`, owned("javascript:alert(1)")).missingSlots).toEqual([
      refusal("url-scheme"),
    ]);
    // A plain relative address passes the link rule.
    expect(render(`<a href="{{title}}">x</a>`, owned("/de/hilfe")).html).toBe(
      `<a href="/de/hilfe">x</a>`,
    );
  });

  it("refuses a harmless value in an event handler, a style, srcdoc and a script or style body", () => {
    const cases: [string, string][] = [
      [`<button onclick="track('{{title}}')">x</button>`, "context-event-handler"],
      [`<script>var t = "{{title}}";</script>`, "context-script"],
      [`<style>.a::after{content:"{{title}}"}</style>`, "context-style"],
      [`<p style="color:{{title}}">x</p>`, "context-style-attribute"],
      [`<iframe srcdoc="{{title}}"></iframe>`, "context-srcdoc"],
      [`<div {{title}}>x</div>`, "context-tag"],
    ];
    for (const [html, rule] of cases) {
      const r = render(html, owned("hello"));
      expect(r.missingSlots).toEqual([refusal(rule)]);
      expect(r.html).toBe(html);
    }
  });

  it("renders a core value in those same spots exactly as before", () => {
    const html = `<a href="{{title}}" onclick="track('{{title}}')" style="color:{{title}}" title={{title}}>{{title}}</a><script>var t = "{{title}}";</script>`;
    const r = render(html, "javascript:alert(1)");
    expect(r.html).toBe(
      `<a href="javascript:alert(1)" onclick="track('javascript:alert(1)')" style="color:javascript:alert(1)" title=javascript:alert(1)>javascript:alert(1)</a><script>var t = "javascript:alert(1)";</script>`,
    );
    expect(r.missingSlots).toEqual([]);
  });

  it("escapes an unquoted attribute so the value stays one, whitespace included", () => {
    expect(render(`<i title={{title}} class="x"></i>`, owned("a b=c")).html).toBe(
      `<i title=a&#32;b&#61;c class="x"></i>`,
    );
    expect(render(`<i title={{title}} class="x"></i>`, owned("")).html).toBe(
      `<i title="" class="x"></i>`,
    );
  });

  it("holds a URL's later parts to the URL characters and refuses a composed scheme", () => {
    expect(render(`<a href="/de/{{title}}">x</a>`, owned("hilfe")).html).toBe(
      `<a href="/de/hilfe">x</a>`,
    );
    expect(render(`<a href="/de/{{title}}">x</a>`, owned("a b")).missingSlots).toEqual([
      refusal("url-characters"),
    ]);
    expect(render(`<a href="{{title}}:alert(1)">x</a>`, owned("javascript")).missingSlots).toEqual([
      refusal("url-composed"),
    ]);
  });

  it("reads the template's URL text as written: a `&` before the scheme ends, or a section, may change it", () => {
    const refused = (html: string, value: string) => render(html, owned(value)).missingSlots;
    // An encoded colon in the template makes the value the scheme.
    expect(refused(`<a href="{{title}}&#58;alert(1)">x</a>`, "javascript")).toEqual([
      refusal("url-composed"),
    ]);
    // A path that only a section adds may be absent.
    expect(
      refused(`<a href="{{#title}}/safe/{{/title}}{{title}}">x</a>`, "javascript:alert(1)"),
    ).toEqual([refusal("url-composed")]);
    // The template's own script scheme makes any value code.
    for (const html of [
      `<a href="javascript:{{title}}">x</a>`,
      `<a href="java\tscript:{{title}}">x</a>`,
    ]) {
      expect(refused(html, "alert(1)")).toEqual([refusal("context-url-scheme")]);
    }
    // A character reference the browser completes across the value or a
    // section: no analysis of the pieces can say what it decodes to.
    for (const [html, value] of [
      [`<a href="JavaScript&#58;{{title}}">x</a>`, "alert(1)"],
      [`<a href="jav&#{{title}};script:alert(1)">x</a>`, "97"],
      [`<a href="{{title}}&#{{#title}}{{/title}}58;alert(1)">x</a>`, "javascript"],
      [`<a href="java&{{#title}}{{/title}}#115;cript&#58;{{title}}">x</a>`, "alert(1)"],
      [`<img srcset="/a.png 1x&#44;{{title}}">`, "javascript:alert(1)"],
    ] as const) {
      expect(refused(html, value)).toEqual([refusal("url-composed")]);
    }
    // The value's own `&` starts no reference with the text after it.
    expect(render(`<a href="{{title}}#58;alert(1)">x</a>`, owned("javascript&")).html).toBe(
      `<a href="javascript&amp;#58;alert(1)">x</a>`,
    );
    // A query's `&` after the scheme ends is just text, and the value's is written `&amp;`.
    expect(render(`<a href="/s?a=1&b={{title}}">x</a>`, owned("x&y=2")).html).toBe(
      `<a href="/s?a=1&b=x&amp;y=2">x</a>`,
    );
    // An unconditional path start holds whatever a section adds after it.
    expect(render(`<a href="/de/{{#title}}x/{{/title}}{{title}}">x</a>`, owned("hilfe")).html).toBe(
      `<a href="/de/x/hilfe">x</a>`,
    );
  });

  it("keeps a richtext markup only in element content, never in a comment or a text-only element", () => {
    const fields: TemplateField[] = [
      { name: "body", kind: "richtext" },
      { name: "title", kind: "text" },
    ];
    const at = (html: string, body: string, title = "alert(1)") =>
      renderTemplate({
        html,
        fields,
        contentValues: { body: owned(body, "richtext"), title: owned(title) },
      });
    // The finding's case: the richtext's `-->` closes nothing.
    const inComment = at(`<!--{{body}}<button onclick="{{title}}">x</button>-->`, "-->");
    expect(inComment.missingSlots).toEqual([]);
    expect(inComment.html).toBe(`<!----&gt;<button onclick="alert(1)">x</button>-->`);
    for (const el of ["title", "textarea", "xmp"]) {
      expect(at(`<${el}>{{body}}</${el}>`, "<strong>x</strong>").html).toBe(
        `<${el}>&lt;strong&gt;x&lt;/strong&gt;</${el}>`,
      );
    }
    expect(at(`<div>{{body}}</div>`, "<p><strong>x</strong></p>").html).toBe(
      `<div><p><strong>x</strong></p></div>`,
    );
  });

  it("reads a self-closed text element as a browser does: it opens all the same", () => {
    const fields: TemplateField[] = [
      { name: "title", kind: "text" },
      { name: "body", kind: "richtext" },
    ];
    const at = (html: string, title: unknown = owned("alert(1)")) =>
      renderTemplate({
        html,
        fields,
        contentValues: { title, body: owned("<strong>x</strong>", "richtext") },
      });
    expect(at(`<script/>{{title}}</script>`).missingSlots).toEqual([refusal("context-script")]);
    expect(at(`<STYLE/>{{title}}</style >`).missingSlots).toEqual([refusal("context-style")]);
    // In a self-closed <textarea> what reads as a tag is text: escaped, never a handler.
    const textarea = at(`<textarea/><b onclick="{{title}}">{{body}}</b></textarea>`);
    expect(textarea.missingSlots).toEqual([]);
    expect(textarea.html).toBe(
      `<textarea/><b onclick="alert(1)">&lt;strong&gt;x&lt;/strong&gt;</b></textarea>`,
    );
    // After its end tag the page reads as before.
    expect(at(`<script/>x</script><p>{{title}}</p>`).html).toBe(
      `<script/>x</script><p>alert(1)</p>`,
    );
    // A core value in the same place renders exactly as before.
    expect(at(`<script/>{{title}}</script>`, "alert(1)").html).toBe(`<script/>alert(1)</script>`);
  });

  it("refuses a richtext that does not end in element content", () => {
    for (const html of [
      "<p onclick=alert(1)//",
      '<p title="x',
      "<!-- a",
      "a<",
      "a</",
      "a<!",
      "a<di",
      "<!-",
      "<br",
    ]) {
      expect(richtextProblem(html)).toBe("richtext-unfinished");
    }
    for (const html of ["", "a", "<p>a &amp; b</p>", "<p>x</p><!-- c -->", "a < b", "<br>"]) {
      expect(richtextProblem(html)).toBeNull();
    }
  });

  it("refuses every value after a section that can change the HTML around it", () => {
    const fields: TemplateField[] = [
      { name: "title", kind: "text" },
      { name: "flag", kind: "text" },
    ];
    const at = (html: string, flag: string, value: unknown = owned("alert(1)")) =>
      renderTemplate({ html, fields, contentValues: { title: value, flag } });
    // The finding's case: without the flag the comment never opens.
    const comment = `{{#flag}}<!--{{/flag}}<button onclick="{{title}}">x</button>{{#flag}}-->{{/flag}}`;
    for (const flag of ["", "1"]) {
      expect(at(comment, flag).missingSlots).toEqual([refusal("context-conditional-markup")]);
      expect(at(comment, flag).html).toContain(`onclick="{{title}}"`);
    }
    for (const html of [
      // A section that cuts into a tag name, an attribute name, or a comment's end.
      `a<{{#flag}}x{{/flag}}script>{{title}}`,
      `<a {{#flag}}x{{/flag}}href="{{title}}">x</a>`,
      `<!--{{#flag}}x{{/flag}}><p title="{{title}}">`,
      // Without the block, the next attribute joins the tag name or becomes the value.
      `<li{{#flag}} class="x"{{/flag}}title="{{title}}">x</li>`,
      `<p title={{#flag}}x{{/flag}} class="{{title}}">x</p>`,
      // Open and close in different attributes, or in a <textarea>.
      `<p title="{{#flag}}" data-x="{{/flag}}">{{title}}</p>`,
      `{{#flag}}<textarea>{{/flag}}<p>{{title}}</p>`,
    ]) {
      expect(at(html, "1", owned("hello")).missingSlots).toEqual([
        refusal("context-conditional-markup"),
      ]);
    }
    // A core value in the same template renders exactly as before.
    expect(at(comment, "", "alert(1)").html).toBe(`<button onclick="alert(1)">x</button>`);
  });

  it("keeps the sections modules use: in content, in one attribute, between attributes", () => {
    const fields: TemplateField[] = [
      { name: "title", kind: "text" },
      { name: "on", kind: "text" },
    ];
    for (const [html, out] of [
      [
        `<li class="item {{#on}}active{{/on}}">{{title}}</li>`,
        `<li class="item active">hilfe</li>`,
      ],
      [
        `<a href="/" {{#on}}target="_blank" rel="noopener"{{/on}}>{{title}}</a>`,
        `<a href="/" target="_blank" rel="noopener">hilfe</a>`,
      ],
      [`<li{{#on}} class="active"{{/on}}>{{title}}</li>`, `<li class="active">hilfe</li>`],
      [`<p title=a{{#on}}b{{/on}} class="{{title}}">x</p>`, `<p title=ab class="hilfe">x</p>`],
      [
        `{{#on}}<p>{{title}}</p>{{/on}}{{^on}}<p>-</p>{{/on}}<i title="{{title}}"></i>`,
        `<p>hilfe</p><i title="hilfe"></i>`,
      ],
    ] as const) {
      const r = renderTemplate({ html, fields, contentValues: { title: owned("hilfe"), on: "1" } });
      expect(r.missingSlots).toEqual([]);
      expect(r.html).toBe(out);
    }
    // An attribute a section adds is read by its own name: `onclick`, not the masked one.
    const handler = renderTemplate({
      html: `<button {{#on}}onclick="{{title}}"{{/on}}>x</button>`,
      fields,
      contentValues: { title: owned("alert(1)"), on: "1" },
    });
    expect(handler.missingSlots).toEqual([refusal("context-event-handler")]);
    const link = renderTemplate({
      html: `<a {{#on}}href="{{title}}"{{/on}}>x</a>`,
      fields,
      contentValues: { title: owned("javascript:alert(1)"), on: "1" },
    });
    expect(link.missingSlots).toEqual([refusal("url-scheme")]);
  });

  it("reads a nested module's partial in content as complete markup, and refuses values after one anywhere else", () => {
    const fields: TemplateField[] = [
      { name: "title", kind: "text" },
      { name: "inner", kind: "module" },
    ];
    const at = (html: string) =>
      renderTemplate({
        html,
        fields,
        contentValues: { title: owned("hilfe"), inner: { moduleId: "m", contentInstanceId: "c" } },
        partials: { inner: "<b>n</b>" },
      });
    expect(at(`<div>{{>inner}}</div><p>{{title}}</p>`).html).toBe(
      `<div><b>n</b></div><p>hilfe</p>`,
    );
    expect(at(`<p title="{{>inner}}">{{title}}</p>`).missingSlots).toEqual([
      refusal("context-conditional-markup"),
    ]);
  });

  it("refuses a value in an attribute or element a value names", () => {
    const fields: TemplateField[] = [
      { name: "title", kind: "text" },
      { name: "attr", kind: "text" },
    ];
    for (const html of [
      `<a {{attr}}="{{title}}">x</a>`,
      `<{{attr}} href="/" title="{{title}}">x</{{attr}}>`,
    ]) {
      const r = renderTemplate({
        html,
        fields,
        contentValues: { title: owned("alert(1)"), attr: "onclick" },
      });
      expect(r.missingSlots).toEqual([refusal("context-tag")]);
    }
  });

  it("refuses a value a list section repeats inside one URL", () => {
    const entry = (id: string, label: string) => ({
      id,
      values: {
        label: pluginValue(
          { plugin: "probe", point: "probe_items", address: "label", type: "text" },
          label,
        ),
      },
    });
    const lists = createListRenderContext(fixtureData()).forPage(PAGE.home, {
      pluginSources: { probe_items: [entry("a", "javascript"), entry("b", ":alert(1)")] },
    });
    const r = renderTemplate({
      html: `<a href="{{#probe_items}}{{label}}{{/probe_items}}">x</a>`,
      fields: [],
      lists,
    });
    expect(r.missingSlots).toEqual([
      "plugin-value-refused:probe.probe_items.label:url-composed",
      "plugin-value-refused:probe.probe_items.label:url-composed",
    ]);
    expect(r.html).not.toContain("javascript");
  });

  it("keeps a plugin's richtext prose in text and escapes it in an attribute", () => {
    const fields: TemplateField[] = [{ name: "title", kind: "richtext" }];
    const prose = owned("<p>Hallo <strong>Welt</strong></p>", "richtext");
    expect(render(`<div>{{{title}}}</div><i title="{{title}}"></i>`, prose, fields).html).toBe(
      `<div><p>Hallo <strong>Welt</strong></p></div><i title="&lt;p&gt;Hallo &lt;strong&gt;Welt&lt;/strong&gt;&lt;/p&gt;"></i>`,
    );
  });

  it("checks a plugin's link and a conditional's dot by their places", () => {
    const fields: TemplateField[] = [{ name: "title", kind: "link" }];
    const link = owned({ href: "/de/hilfe", target: "_blank" }, "link");
    expect(
      render(`<a href="{{title.href}}" target="{{title.target}}">{{title}}</a>`, link, fields).html,
    ).toBe(`<a href="/de/hilfe" target="_blank">/de/hilfe</a>`);
    expect(
      render(`{{#title}}<button onclick="go('{{.}}')">{{.}}</button>{{/title}}`, owned("x"))
        .missingSlots,
    ).toEqual([refusal("context-event-handler")]);
  });

  it("checks a plugin list source's entries by their places", () => {
    const entries = [
      {
        id: "e1",
        values: {
          label: pluginValue(
            { plugin: "probe", point: "probe_items", address: "label", type: "text" },
            TITLE,
          ),
        },
      },
    ];
    const lists = createListRenderContext(fixtureData()).forPage(PAGE.home, {
      pluginSources: { probe_items: entries },
    });
    const r = renderTemplate({
      html: `<ul>{{#probe_items}}<li title="{{label}}">{{label}}</li><li><a href="{{label}}">x</a></li>{{/probe_items}}</ul>`,
      fields: [],
      lists,
    });
    expect(r.html).toBe(
      `<ul><li title="${TITLE}">${TITLE}</li><li><a href="{{label}}">x</a></li></ul>`,
    );
    expect(r.missingSlots).toEqual(["plugin-value-refused:probe.probe_items.label:url-characters"]);
  });
});

describe("a module value and a list entry of the same name (#1729)", () => {
  it("lets the entry answer inside its section and the module field outside", () => {
    const lists = createListRenderContext(fixtureData()).forPage(PAGE.home, {
      pluginSources: { probe_items: [{ id: "e1", values: { title: "from the entry" } }] },
    });
    const r = renderTemplate({
      html: `<h1>{{title}}</h1>{{#probe_items}}<li>{{title}}</li>{{/probe_items}}`,
      fields: [{ name: "title", kind: "text" }],
      contentValues: { title: owned("from the variant") },
      lists,
    });
    expect(r.html).toBe("<h1>from the variant</h1><li>from the entry</li>");
  });
});

describe("placeholderContexts (#1729)", () => {
  it("names the place of every value tag, once per template", () => {
    const html = `<a href="{{u}}" title="{{t}}" onclick="{{h}}">{{x}}</a><a href="mailto:{{m}}">m</a><img srcset="{{s1}} 1x, {{s2}} 2x"><a href="{{#c}}{{w}}{{/c}}">w</a>`;
    const at = (tag: string) => placeholderContexts(html).byStart.get(html.indexOf(tag));
    expect(at("{{u}}")).toEqual({ kind: "url", quoted: true, position: "whole" });
    expect(at("{{t}}")).toEqual({ kind: "attribute", quoted: true });
    expect(at("{{h}}")).toEqual({ kind: "refused", rule: "context-event-handler" });
    expect(at("{{x}}")).toEqual({ kind: "text", markup: true });
    expect(at("{{m}}")).toEqual({ kind: "url", quoted: true, position: "path" });
    expect(at("{{s2}}")).toEqual({ kind: "url", quoted: true, position: "whole" });
    // Inside a section: a list section would repeat it, so it never decides alone.
    expect(at("{{w}}")).toEqual({ kind: "url", quoted: true, position: "composed" });
    expect(placeholderContexts(html)).toBe(placeholderContexts(html));
  });
});
