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
import { type PluginValueOrigin, pluginValue } from "./lists/plugin-values.js";
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
    expect(at("{{x}}")).toEqual({ kind: "text" });
    expect(at("{{m}}")).toEqual({ kind: "url", quoted: true, position: "path" });
    expect(at("{{s2}}")).toEqual({ kind: "url", quoted: true, position: "whole" });
    expect(at("{{w}}")).toEqual({ kind: "url", quoted: true, position: "whole" });
    expect(placeholderContexts(html)).toBe(placeholderContexts(html));
  });
});
