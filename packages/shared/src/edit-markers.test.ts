// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { finalizeEditMarkers, wrapEditableValues } from "./edit-markers.js";
import { renderTemplate } from "./template-engine.js";

const FIELDS = [
  { name: "title", kind: "text" },
  { name: "tags", kind: "text-list" },
  { name: "links", kind: "link-list" },
  { name: "photo", kind: "image" },
] as const;

function render(html: string, values: Record<string, unknown>, synced = false): string {
  const wrapped = wrapEditableValues(values, FIELDS);
  const rendered = renderTemplate({ html, fields: [...FIELDS], contentValues: wrapped }).html;
  return finalizeEditMarkers(rendered, "content#2", synced);
}

const open = (f: string, s = 0) => `<!--caelo:f p=content%232 s=${s} f=${f}-->`;
const close = "<!--/caelo:f-->";

describe("edit markers (#917)", () => {
  it("marks a text field in text content", () => {
    expect(render("<h1>{{title}}</h1>", { title: "Hello & welcome" })).toBe(
      `<h1>${open("title")}Hello & welcome${close}</h1>`,
    );
  });

  it("flags a synced placement", () => {
    expect(render("<h1>{{title}}</h1>", { title: "Hi" }, true)).toContain(open("title", 1));
  });

  it("marks text-list items and link-list labels with their index", () => {
    const html = render(
      '<ul>{{#tags}}<li>{{.}}</li>{{/tags}}</ul><nav>{{#links}}<a href="{{href}}">{{label}}</a>{{/links}}</nav>',
      {
        tags: ["a", "b"],
        links: [{ label: "Docs", href: "/docs" }],
      },
    );
    expect(html).toContain(`<li>${open("tags.1")}b${close}</li>`);
    expect(html).toContain(`<a href="/docs">${open("links.0.label")}Docs${close}</a>`);
  });

  it("leaves attributes, scripts, styles and titles byte-identical", () => {
    const html = render(
      '<img alt="{{title}}" data-x=\'{{title}}\'><script>var t = "{{title}}";</script><style>/* {{title}} */</style><title>{{title}}</title><!-- {{title}} -->',
      { title: "Hi > there" },
    );
    expect(html).toBe(
      '<img alt="Hi > there" data-x=\'Hi > there\'><script>var t = "Hi > there";</script><style>/* Hi > there */</style><title>Hi > there</title><!-- Hi > there -->',
    );
    expect(html).not.toMatch(/[\uE000-\uE002]/);
  });

  it("does not mark values that carry markup, empty values, or non-text kinds", () => {
    const html = render("<h1>{{title}}</h1><p>{{#tags}}{{.}}{{/tags}}</p>", {
      title: "<b>Bold</b>",
      tags: [" "],
    });
    expect(html).toBe("<h1><b>Bold</b></h1><p> </p>");
    expect(wrapEditableValues({ photo: "x.png" }, FIELDS)).toEqual({ photo: "x.png" });
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
      false,
    );
    expect(out).toBe("<!--caelo:f p=main%2D%2Dslot%230 s=0 f=a%2D%2Db-->x<!--/caelo:f-->");
  });

  it("is a no-op on HTML without sentinels", () => {
    const html = "<h1>Plain</h1><!-- caelo:missing reason=x -->";
    expect(finalizeEditMarkers(html, "content#0", false)).toBe(html);
  });
});
