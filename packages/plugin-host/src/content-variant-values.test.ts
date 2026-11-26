// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the values a content variant hands a placement are held to the
 * rule for the field of the module that renders them
 * (docs/dev/external-plugin-brokers.md §6.6, §4.5), for every plugin. A
 * value equal to what core would render there is core's own; a refused
 * value becomes its stand-in, which the template engine records as
 * `plugin-value-refused` and keeps raw (never the field's default).
 */

import { describe, expect, it } from "bun:test";
import { refusedPluginValueMarker, renderTemplate } from "@caelo-cms/shared";
import { checkContentVariantValues } from "./content-variants.js";

const IMAGE = "00000000-0000-4000-8000-0000000000a1";
const REFERENCE = "00000000-0000-4000-8000-0000000000a2";
const fields = [
  { name: "title", kind: "text" },
  { name: "body", kind: "richtext" },
  { name: "cta", kind: "link" },
  { name: "logo", kind: "image" },
  { name: "count", kind: "number" },
  { name: "wide", kind: "boolean" },
  { name: "links", kind: "list" },
  { name: "teaser", kind: "module" },
];
const stored = {
  title: "Hello <em>world</em>",
  body: "<p>Hi</p>",
  cta: { href: "https://example.com" },
  logo: `caelo:media/${IMAGE}`,
  links: [{ id: "a", node: "link", values: { label: "Docs", link: { href: "/docs" } } }],
  teaser: { moduleId: IMAGE, contentInstanceId: IMAGE },
};

function check(values: Record<string, unknown>) {
  return checkContentVariantValues({
    pluginSlug: "probe",
    key: "layout:footer:0",
    fields,
    stored,
    values,
    media: {
      [IMAGE]: { visibility: "library", mime: "image/png" },
      [REFERENCE]: { visibility: "reference", mime: "image/png" },
    },
  });
}

const rule = (v: unknown) => refusedPluginValueMarker(v)?.split(":").at(-1) ?? null;

describe("content-variant values (#1729, §4.5)", () => {
  it("keeps core's own values and passes checked translations", () => {
    const out = check({
      ...stored,
      body: '<p>Hallo <strong>Welt</strong> <a href="caelo:page/x">mehr</a></p>',
      cta: { href: "mailto:hi@example.com" },
      count: 3,
      wide: true,
      links: [{ id: "a", node: "link", values: { label: "Doku", link: { href: "/de/docs" } } }],
    });
    // Equal to what core renders: untouched, markup and all.
    expect(out.title).toBe("Hello <em>world</em>");
    expect(out.teaser).toEqual(stored.teaser);
    expect(rule(out.body)).toBeNull();
    expect(rule(out.cta)).toBeNull();
    expect(rule(out.links)).toBeNull();
    expect(out.count).toBe(3);
  });

  it("escapes a translated text and refuses what may not reach a page", () => {
    const out = check({
      title: "<img src=x onerror=alert(1)>",
      body: "<p>x</p><script>alert(1)</script>",
      cta: { href: "javascript:alert(1)" },
      logo: `caelo:media/${REFERENCE}`,
      count: "<b>9</b>",
      wide: "yes",
      links: [
        { id: "a", node: "link", values: { label: "<b onclick=x>D</b>", link: { href: "/d" } } },
      ],
      teaser: { moduleId: REFERENCE, contentInstanceId: REFERENCE },
      ghost: "not a field of the module",
    });
    expect(out.title).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, rule(v)]))).toEqual({
      title: null,
      body: "element-script",
      cta: "url-scheme",
      logo: "media-reference",
      count: "type-number",
      wide: "type-boolean",
      links: "element-b",
      teaser: "structural-field",
      ghost: "undeclared-field",
    });
    expect(refusedPluginValueMarker(out.ghost)).toBe(
      "plugin-value-refused:probe.content-variants.layout:footer:0/ghost:undeclared-field",
    );
    // A protocol-relative link and an image that is no library reference.
    const more = check({
      cta: { href: "//evil.example/x" },
      logo: "https://tracker.example/p.gif",
    });
    expect([rule(more.cta), rule(more.logo)]).toEqual([
      "url-protocol-relative",
      "media-not-library-image",
    ]);
  });

  it("renders a refused value raw and records it, never the field's default", () => {
    const out = check({ title: "Hallo", body: "<p>x</p><script>alert(1)</script>", ghost: "x" });
    const r = renderTemplate({
      html: "<h1>{{title}}</h1><div>{{body}}</div>",
      fields: [
        { name: "title", kind: "text" },
        { name: "body", kind: "richtext", default: "<p>Source language</p>" },
      ],
      contentValues: out,
    });
    expect(r.html).toBe("<h1>Hallo</h1><div>{{body}}</div>");
    expect(r.missingSlots).toEqual([
      "plugin-value-refused:probe.content-variants.layout:footer:0/body:element-script",
      "plugin-value-refused:probe.content-variants.layout:footer:0/ghost:undeclared-field",
    ]);
  });
});
