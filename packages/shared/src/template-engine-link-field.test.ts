// SPDX-License-Identifier: MPL-2.0

/**
 * #1433 — a top-level `link` field reads the way a link inside a list entry
 * does (`docs/lists.md` §2): `{{f}}` = href, `{{f.href}}`, `{{f.target}}`,
 * `{{f.title}}`. A path no value can answer stays raw and is reported with a
 * marker the Stage refuses (never literal `{{…}}` in published HTML).
 */

import { describe, expect, it } from "bun:test";
import { LINK_VALUE_KEYS, linkValue } from "./lists/resolve-values.js";
import {
  describeFieldPathProblems,
  fieldPathProblems,
  renderTemplate,
  type TemplateField,
} from "./template-engine.js";

const CTA: TemplateField = { name: "primary_cta", kind: "link" };

function render(html: string, value: unknown, fields: readonly TemplateField[] = [CTA]) {
  return renderTemplate({
    html,
    fields,
    contentValues: value === undefined ? {} : { primary_cta: value },
  });
}

describe("#1433 top-level link field", () => {
  it("resolves dot paths outside a list", () => {
    const r = render('<a href="{{primary_cta.href}}" target="{{primary_cta.target}}">x</a>', {
      href: "/pricing",
      target: "_blank",
    });
    expect(r.html).toBe('<a href="/pricing" target="_blank">x</a>');
    expect(r.missingSlots).toEqual([]);
  });

  it("the bare key is the href, never [object Object]", () => {
    const r = render('<a href="{{primary_cta}}">x</a>', { href: "/pricing" });
    expect(r.html).toBe('<a href="/pricing">x</a>');
    expect(r.missingSlots).toEqual([]);
    expect(render('<a href="{{{primary_cta}}}">x</a>', { href: "/p" }).html).toBe(
      '<a href="/p">x</a>',
    );
  });

  it("an object with an empty href is no value, never [object Object]", () => {
    expect(render("{{primary_cta}}", { href: "" }).html).toBe("{{primary_cta}}");
    expect(render("{{{primary_cta}}}", { href: "" }).html).toBe("{{{primary_cta}}}");
  });

  it("a string value reads the same", () => {
    const r = render("{{primary_cta}}|{{primary_cta.href}}|{{primary_cta.target}}", "/p");
    expect(r.html).toBe("/p|/p|");
    expect(r.missingSlots).toEqual([]);
  });

  it("reads the field default when the placement has no value", () => {
    const r = renderTemplate({
      html: "{{primary_cta.href}}",
      fields: [{ ...CTA, default: { href: "/d" } }],
    });
    expect(r.html).toBe("/d");
  });

  it("works inside a scalar conditional and for a path used as one", () => {
    expect(
      render('{{#primary_cta}}<a href="{{.}}">x</a>{{/primary_cta}}', { href: "/p" }).html,
    ).toBe('<a href="/p">x</a>');
    expect(render("{{#primary_cta}}x{{/primary_cta}}", undefined).html).toBe("");
    const t = '{{#primary_cta.target}} target="{{primary_cta.target}}"{{/primary_cta.target}}';
    expect(render(t, { href: "/p" }).html).toBe("");
    expect(render(t, { href: "/p", target: "_blank" }).html).toBe(' target="_blank"');
  });

  it("an unknown path stays raw and reports the marker the Stage refuses", () => {
    const r = render("{{primary_cta.label}}", { href: "/p", label: "Go" });
    expect(r.html).toBe("{{primary_cta.label}}");
    expect(r.missingSlots).toEqual(["field-path-unknown:primary_cta.label"]);
  });

  it("a path into an empty link and a malformed value are reported, never empty", () => {
    const empty = render('<a href="{{primary_cta.href}}">x</a>', undefined);
    expect(empty.html).toBe('<a href="{{primary_cta.href}}">x</a>');
    expect(empty.missingSlots).toEqual(["field-value-empty:primary_cta.href"]);
    const bad = render("{{primary_cta.href}}", { url: "/p" });
    expect(bad.missingSlots).toEqual(["field-value-malformed:primary_cta"]);
  });

  it("a path into a field of another kind is reported too", () => {
    const r = renderTemplate({
      html: "{{title.text}}",
      fields: [{ name: "title", kind: "text" }],
      contentValues: { title: "Hi" },
    });
    expect(r.html).toBe("{{title.text}}");
    expect(r.missingSlots).toEqual(["field-path-unknown:title.text"]);
  });

  it("a dotted name of no field stays literal copy", () => {
    const r = render("{{acme.version}}", { href: "/p" });
    expect(r.html).toBe("{{acme.version}}");
    expect(r.missingSlots).toEqual([]);
  });

  it("LINK_VALUE_KEYS are the paths a link value answers", () => {
    const v = linkValue({ href: "/p" }, null);
    if (v.kind !== "record") throw new Error("a link is a record");
    for (const key of LINK_VALUE_KEYS) expect(v.get(key)).toBeDefined();
  });
});

describe("#1433 fieldPathProblems", () => {
  const FIELDS = [
    { name: "cta", kind: "link" },
    { name: "title", kind: "text" },
    { name: "nav", kind: "list" },
  ];

  it("accepts what renders", () => {
    const html =
      '{{cta}}{{cta.href}}{{cta.target}}{{cta.title}}{{page.title}}{{site_text.x}}{{other.y}}{{#cta.target}}{{/cta.target}}{{#nav}}<a href="{{link.href}}">{{link.label}}</a>{{/nav}}';
    expect(fieldPathProblems(html, FIELDS)).toEqual([]);
  });

  it("names a path no value can answer, with the form that works", () => {
    const problems = fieldPathProblems("{{cta.label}} {{title.text}} {{nav.items}}", FIELDS);
    expect(problems.map((p) => p.tag)).toEqual([
      "{{cta.label}}",
      "{{title.text}}",
      "{{nav.items}}",
    ]);
    const message = describeFieldPathProblems(problems);
    expect(message).toContain("{{cta.href}}");
    expect(message).toContain("`cta_label`");
    expect(message).toContain("{{title}}");
    expect(message).toContain("{{#nav}}");
  });

  it("reads inside a scalar conditional, not inside a section of entries", () => {
    expect(fieldPathProblems("{{#cta}}{{cta.label}}{{/cta}}", FIELDS)).toHaveLength(1);
    expect(fieldPathProblems("{{#cta.href}}{{cta.label}}{{/cta.href}}", FIELDS)).toHaveLength(1);
    expect(
      fieldPathProblems("{{#page.terms.tags}}{{cta.label}}{{/page.terms.tags}}", FIELDS),
    ).toEqual([]);
  });
});
