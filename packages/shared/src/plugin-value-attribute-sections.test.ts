// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 (docs/dev/external-plugin-brokers.md §4.5) — a section around
 * attributes inside a start tag (`<input {{#required}}checked
 * disabled{{/required}}>`) is ordinary module markup: the values around it
 * are read where they land and substituted. The real-AI cookie-banner run
 * of PR #1787 wrote exactly that, and every value of the banner stayed a
 * raw `{{key}}`: the section was read as one that could change the HTML
 * after it, so the module "ended outside content" and the page refused
 * every plugin value on it. A section whose block can move a value (a
 * repeated block joining two names into an event handler, an attribute that
 * ends SVG) is still refused.
 */

import { describe, expect, it } from "bun:test";
import { fixtureData, fixtureLinkIndex, PAGE } from "./lists/list-fixtures.test.js";
import { pluginValue } from "./lists/plugin-values.js";
import type { PluginSourceEntry } from "./lists/render-data.js";
import { createListRenderContext } from "./lists/resolve.js";
import { templateEndsInContent } from "./page-reading.js";
import { renderTemplate, type TemplateField } from "./template-engine.js";

const PLUGIN = "consent-manager";
const SOURCE = "consent_categories";

/** A list source entry as the plugin host hands it over: every value the plugin's (`list-source-resolution.ts`). */
function entry(id: string, values: Record<string, [string, unknown]>): PluginSourceEntry {
  return {
    id,
    plugin: PLUGIN,
    values: Object.fromEntries(
      Object.entries(values).map(([key, [type, value]]) => [
        key,
        pluginValue({ plugin: PLUGIN, point: SOURCE, address: key, type }, value),
      ]),
    ),
  };
}

const CATEGORIES = [
  entry("necessary", {
    key: ["text", "necessary"],
    label: ["text", "Necessary"],
    description: ["text", "Session & security <always>"],
    required: ["boolean", true],
  }),
  entry("analytics", {
    key: ["text", "analytics"],
    label: ["text", "Analytics"],
    description: ["text", "Which pages are useful"],
    required: ["boolean", false],
  }),
];

/** Rendered the way the editor preview and the static generator render a module over a plugin source. */
function render(html: string, entries = CATEGORIES, fields: TemplateField[] = []) {
  const lists = createListRenderContext(fixtureData(), {}).forPage(PAGE.home, {
    linkResolver: fixtureLinkIndex().forPage(PAGE.home),
    pluginSources: { [SOURCE]: entries },
  });
  return renderTemplate({
    html,
    fields,
    contentValues: {},
    lists,
    linkResolver: fixtureLinkIndex().forPage(PAGE.home),
  });
}

const refused = (field: string, rule: string) =>
  `plugin-value-refused:${PLUGIN}.${SOURCE}.${field}:${rule}`;

/** The banner module the real AI wrote in run 45970549880, verbatim. */
const BANNER = `<div class="cookie-banner" data-consent-banner role="dialog" aria-modal="false" aria-labelledby="cookie-banner-title">
  <div class="cookie-banner__head">
    <h2 class="cookie-banner__title" id="cookie-banner-title">{{banner_title}}</h2>
    <p class="cookie-banner__intro">{{banner_intro}}</p>
  </div>
  <ul class="cookie-banner__list">
    {{#consent_categories}}
    <li class="cookie-banner__item">
      <label class="cookie-banner__option">
        <input class="cookie-banner__check" type="checkbox" data-consent-category="{{key}}" {{#required}}checked disabled{{/required}}>
        <span class="cookie-banner__text">
          <span class="cookie-banner__label">{{label}}</span>
          <span class="cookie-banner__desc">{{description}}</span>
        </span>
      </label>
    </li>
    {{/consent_categories}}
  </ul>
  <div class="cookie-banner__actions">
    <button type="button" class="cookie-banner__btn cookie-banner__btn--solid" data-consent-reject-all>{{reject_label}}</button>
    <button type="button" class="cookie-banner__btn cookie-banner__btn--outline" data-consent-save>{{save_label}}</button>
    <button type="button" class="cookie-banner__btn cookie-banner__btn--solid" data-consent-accept-all>{{accept_label}}</button>
  </div>
</div>`;

const ITEM = (inTag: string) =>
  `<ul>{{#consent_categories}}<li><input type="checkbox" data-consent-category="{{key}}"${inTag}><span>{{label}}</span> <span>{{description}}</span></li>{{/consent_categories}}</ul>`;

describe("a section around attributes in a start tag (#1787)", () => {
  it("renders the real AI's cookie banner: every value read where it lands", () => {
    const fields: TemplateField[] = [
      { name: "banner_title", kind: "text" },
      { name: "banner_intro", kind: "text" },
      { name: "reject_label", kind: "text" },
      { name: "save_label", kind: "text" },
      { name: "accept_label", kind: "text" },
    ];
    const r = render(BANNER, CATEGORIES, fields);
    expect(r.missingSlots).toEqual([]);
    expect(r.html).toContain('data-consent-category="necessary" checked disabled>');
    expect(r.html).toContain('data-consent-category="analytics" >');
    expect(r.html).toContain('<span class="cookie-banner__label">Analytics</span>');
    // Text is escaped where it lands.
    expect(r.html).toContain("Session &amp; security &lt;always&gt;");
    expect(r.html).not.toContain("{{key}}");
    // The module ends in plain content in every render, so the page does
    // not refuse the plugin values on it (`context-open-markup`).
    expect(templateEndsInContent(BANNER)).toBe(true);
  });

  it("keeps every spelling of the boolean attributes: before, after, inverted, declared", () => {
    for (const inTag of [
      " {{#required}}checked disabled{{/required}}",
      " {{#required}} checked disabled{{/required}}",
      "{{#required}} checked disabled{{/required}}",
      " {{#required}}checked{{/required}}",
      " {{#required}}checked disabled {{/required}}",
      " {{^required}}data-optional{{/required}}",
      ' {{^required}}data-choice="optional" data-optional{{/required}}',
      ' {{#required}}checked{{/required}} title="{{label}}"',
      "",
    ]) {
      const html = ITEM(inTag);
      const r = render(html);
      expect({ inTag, missing: r.missingSlots }).toEqual({ inTag, missing: [] });
      expect(r.html).toContain('data-consent-category="analytics"');
      expect(r.html).toContain("<span>Analytics</span>");
      expect(templateEndsInContent(html)).toBe(true);
    }
    // A declared field for the source reads the same.
    const declared: TemplateField[] = [
      {
        name: SOURCE,
        kind: "list",
        listType: "",
        bind: "source",
        source: { kind: "plugin", name: SOURCE },
      },
    ];
    const r = render(ITEM(" {{#required}}checked disabled{{/required}}"), CATEGORIES, declared);
    expect(r.missingSlots).toEqual([]);
    expect(r.html).toContain('data-consent-category="necessary" checked disabled>');
  });

  it("still refuses a block that joins two names into another attribute when it repeats", () => {
    // Two entries render the block twice: the join makes the second value
    // an `onclick`, or makes the `on…click` after the block one name.
    const flags = [
      entry("a", { v: ["text", "alert(1)"] }),
      entry("b", { v: ["text", "alert(1)"] }),
    ];
    const inBlock = `<button {{#consent_categories}}click="{{v}}" on{{/consent_categories}}>x</button>`;
    const r = render(inBlock, flags);
    expect(r.missingSlots).toEqual([
      refused("v", "context-conditional-markup"),
      refused("v", "context-conditional-markup"),
    ]);
    expect(r.html).not.toContain("alert(1)");
    // The same with the value after the block (a module field of the plugin's).
    const fields: TemplateField[] = [{ name: "v", kind: "text" }];
    const v = pluginValue(
      { plugin: PLUGIN, point: SOURCE, address: "v", type: "text" },
      "alert(1)",
    );
    for (const html of [
      `<button {{#consent_categories}}click on{{/consent_categories}}="{{v}}">x</button>`,
      `<button {{#consent_categories}}x on{{/consent_categories}}click="{{v}}">x</button>`,
    ]) {
      const lists = createListRenderContext(fixtureData(), {}).forPage(PAGE.home, {
        pluginSources: { [SOURCE]: flags },
      });
      const out = renderTemplate({ html, fields, contentValues: { v }, lists });
      expect({ html, missing: out.missingSlots }).toEqual({
        html,
        missing: [refused("v", "context-conditional-markup")],
      });
      expect(out.html).not.toContain("alert(1)");
    }
  });

  it("still refuses a section that can move a value into another attribute", () => {
    const fields: TemplateField[] = [
      { name: "val", kind: "text" },
      { name: "x", kind: "boolean" },
    ];
    const val = pluginValue(
      { plugin: PLUGIN, point: SOURCE, address: "val", type: "text" },
      "javascript:alert(1)",
    );
    for (const html of [
      // Rendered, `href="…"`; without the block, an attribute named `"…"`.
      `<a {{#x}}href={{/x}}"{{val}}">x</a>`,
      // One section switches the name between `href` and `title`.
      `<a {{#x}}href{{/x}}{{^x}}title{{/x}}="{{val}}">x</a>`,
      `<a {{^x}}title{{/x}}{{#x}}href{{/x}}="{{val}}">x</a>`,
      // The block continues a name in front of it or behind it.
      `<a hr{{#x}}ef{{/x}}="{{val}}">x</a>`,
      `<a {{#x}}hr{{/x}}ef="{{val}}">x</a>`,
    ]) {
      for (const x of [true, false]) {
        const r = renderTemplate({ html, fields, contentValues: { val, x } });
        expect({ html, x, missing: r.missingSlots }).toEqual({
          html,
          x,
          missing: [`plugin-value-refused:${PLUGIN}.${SOURCE}.val:context-conditional-markup`],
        });
        expect(r.html).not.toContain("javascript:");
      }
    }
  });

  it("refuses values after markup whose attributes decide the namespace (font, annotation-xml)", () => {
    const fields: TemplateField[] = [
      { name: "src", kind: "text" },
      { name: "enc", kind: "text" },
      { name: "x", kind: "boolean" },
    ];
    const owned = (address: string, v: string) =>
      pluginValue({ plugin: PLUGIN, point: SOURCE, address, type: "text" }, v);
    const src = owned("src", "https://evil.example/x.js");
    const rule = (field: string, r: string) =>
      `plugin-value-refused:${PLUGIN}.${SOURCE}.${field}:${r}`;
    for (const [html, values, expected] of [
      // Without `color` the `<font>` stays SVG and its `<script href>` loads code.
      [
        `<svg><font {{#x}} color{{/x}}></font><script href="{{src}}"></script></svg>`,
        { x: false },
        [rule("src", "context-conditional-markup")],
      ],
      // Repeated, `col` + `or` would be a `color` that ends the SVG.
      [
        `<svg><font {{#x}}or x col{{/x}}></font><iframe src="{{src}}"></iframe></svg>`,
        { x: true },
        [rule("src", "context-conditional-markup")],
      ],
      // `text/html` reads the `<annotation-xml>` content as HTML.
      [
        `<math><annotation-xml encoding="{{enc}}"><script src="{{src}}"></script></annotation-xml></math>`,
        { enc: owned("enc", "text/html") },
        [rule("enc", "context-tag"), rule("src", "context-conditional-markup")],
      ],
      [
        `<math><annotation-xml encoding="{{#x}}text/html{{/x}}"><script src="{{src}}"></script></annotation-xml></math>`,
        { x: false },
        [rule("src", "context-conditional-markup")],
      ],
    ] as const) {
      const r = renderTemplate({ html, fields, contentValues: { src, ...values } });
      expect({ html, missing: r.missingSlots }).toEqual({ html, missing: [...expected] });
      expect(r.html).not.toContain("evil.example");
    }
  });

  it("refuses a section whose end leaves an `=` where no attribute name stands", () => {
    const fields: TemplateField[] = [
      { name: "val", kind: "text" },
      { name: "x", kind: "boolean" },
    ];
    // Without the block, `="x onfocus=…"` starts a name at the `=`, and the
    // value's words are read as attributes: an `onfocus` and an `autofocus`.
    const val = pluginValue(
      { plugin: PLUGIN, point: SOURCE, address: "val", type: "text" },
      "x onfocus=alert(1) autofocus x",
    );
    for (const html of [
      `<button {{#x}}x {{/x}}="{{val}}">b</button>`,
      `<button {{#x}}x {{/x}} ="{{val}}">b</button>`,
      `<button {{^x}}x {{/x}}="{{val}}">b</button>`,
      `<button title="t"{{#x}} x{{/x}}="{{val}}">b</button>`,
    ]) {
      for (const x of [true, false]) {
        const r = renderTemplate({ html, fields, contentValues: { val, x } });
        expect({ html, x, missing: r.missingSlots }).toEqual({
          html,
          x,
          missing: [`plugin-value-refused:${PLUGIN}.${SOURCE}.val:context-conditional-markup`],
        });
        expect(r.html).not.toContain("onfocus");
      }
    }
  });
});
