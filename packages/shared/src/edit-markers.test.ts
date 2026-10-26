// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { finalizeEditMarkers, wrapEditableValues } from "./edit-markers.js";
import { DEFAULT_LIST_TYPES } from "./lists/default-types.js";
import { fixtureData } from "./lists/list-fixtures.test.js";
import { createListRenderContext } from "./lists/resolve.js";
import { renderTemplate, type TemplateField } from "./template-engine.js";

const FIELDS: TemplateField[] = [
  { name: "title", kind: "text" },
  { name: "tags", kind: "list", listType: "texts" },
  { name: "links", kind: "list", listType: "links" },
  { name: "photo", kind: "image" },
];
const listTypes = (slug: string) => DEFAULT_LIST_TYPES.find((t) => t.slug === slug);
const lists = createListRenderContext(fixtureData()).forPage(null);

const T1 = "00000000-0000-4000-9000-000000000001";
const T2 = "00000000-0000-4000-9000-000000000002";
const L1 = "00000000-0000-4000-9000-000000000003";
const tags = (...t: string[]) =>
  t.map((text, i) => ({ id: [T1, T2][i], node: "text", values: { text } }));
const links = (label: string, href: string) => [
  { id: L1, node: "link", values: { label, link: { href } } },
];
/** A marker path as the comment encodes it (`-` → %2D). */
const enc = (p: string) => encodeURIComponent(p).replace(/-/g, "%2D");

function render(html: string, values: Record<string, unknown>, sharedPages = 0): string {
  const wrapped = wrapEditableValues(values, FIELDS, listTypes);
  const rendered = renderTemplate({ html, fields: FIELDS, contentValues: wrapped, lists }).html;
  return finalizeEditMarkers(rendered, "content#2", sharedPages).replace(
    / data-caelo-list-item="[^"]*"/g,
    "",
  );
}

const marked = (fields: string, shared = 0) =>
  ` data-caelo-fields="${fields}" data-caelo-placement="content%232" data-caelo-shared="${shared}"`;

const open = (f: string, s = 0) => `<!--caelo:f p=content%232 s=${s} f=${f}-->`;
const close = "<!--/caelo:f-->";

describe("edit markers (#917)", () => {
  it("marks a text field in text content", () => {
    expect(render("<h1>{{title}}</h1>", { title: "Hello & welcome" })).toBe(
      `<h1>${open("title")}Hello & welcome${close}</h1>`,
    );
  });

  it("carries how many pages share a synced placement", () => {
    expect(render("<h1>{{title}}</h1>", { title: "Hi" }, 4)).toContain(open("title", 4));
  });

  it("marks local list entries' text and link targets by entry id", () => {
    const html = render(
      '<ul>{{#tags}}<li>{{text}}</li>{{/tags}}</ul><nav>{{#links}}<a href="{{link}}">{{label}}</a>{{/links}}</nav>',
      { tags: tags("a", "b"), links: links("Docs", "/docs") },
    );
    expect(html).toContain(`<li>${open(enc(`tags.${T2}.text`))}b${close}</li>`);
    expect(html).toContain(
      `<a href="/docs"${marked(`href=${enc(`links.${L1}.link.href`)}`)}>${open(enc(`links.${L1}.label`))}Docs${close}</a>`,
    );
  });

  it("leaves other attributes, scripts, styles and titles byte-identical", () => {
    const html = render(
      '<div data-x=\'{{title}}\' title="{{title}}"></div><script>var t = "{{title}}";</script><style>/* {{title}} */</style><title>{{title}}</title><!-- {{title}} -->',
      { title: "Hi > there" },
    );
    expect(html).toBe(
      '<div data-x=\'Hi > there\' title="Hi > there"></div><script>var t = "Hi > there";</script><style>/* Hi > there */</style><title>Hi > there</title><!-- Hi > there -->',
    );
    expect(html).not.toMatch(/[\uE000-\uE002]/);
  });

  it("marks link targets, images and alt text on their tag (#918)", () => {
    const html = render(
      '{{#links}}<a href="{{link}}">{{label}}</a>{{/links}}<img src="{{photo}}" alt="{{title}}"/>',
      { links: links("Docs", "/docs"), photo: "/m/cup.webp", title: "A cup" },
      2,
    );
    expect(html).toContain(
      `<a href="/docs"${marked(`href=${enc(`links.${L1}.link.href`)}`, 2)}>${open(enc(`links.${L1}.label`), 2)}Docs${close}</a>`,
    );
    expect(html).toContain(
      `<img src="/m/cup.webp" alt="A cup"${marked("src=photo alt=title", 2)}/>`,
    );
  });

  it("does not mark an attribute assembled from several parts", () => {
    expect(render('<a href="/tags/{{title}}">x</a>', { title: "cups" })).toBe(
      '<a href="/tags/cups">x</a>',
    );
  });

  it("does not mark values that carry markup, empty values, or non-text kinds", () => {
    const html = render("<h1>{{title}}</h1><p>{{#tags}}{{text}}{{/tags}}</p>", {
      title: "<b>Bold</b>",
      tags: tags(" "),
    });
    expect(html).toBe("<h1><b>Bold</b></h1><p> </p>");
    expect(wrapEditableValues({ n: 3 }, [{ name: "n", kind: "number" }])).toEqual({ n: 3 });
  });

  it("keeps conditional sections working on wrapped values", () => {
    expect(render("{{#title}}<p>{{title}}</p>{{/title}}", { title: "Hi" })).toBe(
      `<p>${open("title")}Hi${close}</p>`,
    );
    expect(render("{{#title}}<p>{{title}}</p>{{/title}}", {})).toBe("");
  });

  it("encodes placement and field so a comment can never close early", () => {
    const out = finalizeEditMarkers(
      wrapEditableValues({ "a--b": "x" }, [{ name: "a--b", kind: "text" }])["a--b"] as string,
      "main--slot#0",
      0,
    );
    expect(out).toBe("<!--caelo:f p=main%2D%2Dslot%230 s=0 f=a%2D%2Db-->x<!--/caelo:f-->");
  });

  it("is a no-op on HTML without sentinels", () => {
    const html = "<h1>Plain</h1><!-- caelo:missing reason=x -->";
    expect(finalizeEditMarkers(html, "content#0", 0)).toBe(html);
  });
});
