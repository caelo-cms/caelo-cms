// SPDX-License-Identifier: MPL-2.0

/**
 * Template syntax for lists (epic #1107, `docs/lists.md` §8): one test
 * (or more) per syntax row, plus the loud markers. Rendered through the
 * real resolver over the fixture site, so the engine and the resolver
 * are tested as the composer uses them.
 */

import { describe, expect, it } from "bun:test";
import {
  fixtureData,
  fixtureLinkIndex,
  INSTANCE,
  ITEM,
  LIST,
  MODULE,
  PAGE,
  TERM,
} from "./lists/list-fixtures.test.js";
import { createListRenderContext, type ListPageContext } from "./lists/resolve.js";
import { renderTemplate, type TemplateField } from "./template-engine.js";

function ctx(
  pageId: string | null = PAGE.home,
  opts: Parameters<ReturnType<typeof createListRenderContext>["forPage"]>[1] = {},
): ListPageContext {
  return createListRenderContext(fixtureData(), {
    dormantPluginSources: { comments: "comments-plugin" },
  }).forPage(pageId, { linkResolver: fixtureLinkIndex().forPage(pageId), ...opts });
}

function render(
  html: string,
  fields: readonly TemplateField[],
  values: Record<string, unknown> = {},
  lists: ListPageContext | null = ctx(),
  extra: Partial<Parameters<typeof renderTemplate>[0]> = {},
) {
  return renderTemplate({
    html,
    fields,
    contentValues: values,
    ...(lists ? { lists } : {}),
    linkResolver: fixtureLinkIndex().forPage(lists?.pageId ?? null),
    ...extra,
  });
}

const HEADER: TemplateField = {
  name: "menu",
  kind: "list",
  listType: "menu",
  bind: "shared",
  list: `caelo:list/${LIST.header}`,
};
const MEGA: TemplateField = {
  name: "mega",
  kind: "list",
  listType: "mega-menu",
  bind: "shared",
  list: `caelo:list/${LIST.mega}`,
};
const uuid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const TEXTS: TemplateField = { name: "bullets", kind: "list", listType: "texts" };
const bullets = (...texts: string[]) =>
  texts.map((text, i) => ({ id: uuid(i + 1), node: "text", values: { text } }));

describe("lists — {{#f}} iteration and {{^f}} inverted sections", () => {
  it("iterates a local list and stamps each entry's root element", () => {
    const r = render("<ul>{{#bullets}}<li>{{text}}</li>{{/bullets}}</ul>", [TEXTS], {
      bullets: bullets("Fast", "Safe"),
    });
    expect(r.html).toBe(
      `<ul><li data-caelo-list-item="local/bullets/${uuid(1)}">Fast</li><li data-caelo-list-item="local/bullets/${uuid(2)}">Safe</li></ul>`,
    );
    expect(r.missingSlots).toEqual([]);
  });

  it("addresses a local list by its content instance when one holds it", () => {
    const r = render(
      "{{#bullets}}<li>{{text}}</li>{{/bullets}}",
      [TEXTS],
      { bullets: bullets("A") },
      ctx(),
      {
        listHolder: { contentInstanceId: INSTANCE.placement },
      },
    );
    expect(r.html).toContain(
      `data-caelo-list-item="instance/${INSTANCE.placement}/bullets/${uuid(1)}"`,
    );
  });

  it("falls back to the field default for a local list without a placement value", () => {
    const r = render(
      "{{#bullets}}{{text}};{{/bullets}}",
      [{ ...TEXTS, default: bullets("D") }],
      {},
    );
    expect(r.html).toBe("D;");
  });

  it("{{^f}} renders for an empty list and not for a filled one", () => {
    const html = "{{#bullets}}x{{/bullets}}{{^bullets}}none{{/bullets}}";
    expect(render(html, [TEXTS], { bullets: [] }).html).toBe("none");
    expect(render(html, [TEXTS], { bullets: bullets("a") }).html).toBe("x");
  });

  it("{{^f}} works for scalars and module-lists too", () => {
    const fields: TemplateField[] = [
      { name: "title", kind: "text" },
      { name: "cards", kind: "module-list" },
    ];
    const r = render("{{^title}}untitled{{/title}}|{{^cards}}no cards{{/cards}}", fields, {
      cards: [],
    });
    expect(r.html).toBe("untitled|no cards");
    expect(render("{{^title}}untitled{{/title}}", fields, { title: "T" }).html).toBe("");
  });

  it("an entry starting with text gets no stamp", () => {
    const r = render("{{#bullets}}{{text}}, {{/bullets}}", [TEXTS], { bullets: bullets("a", "b") });
    expect(r.html).toBe("a, b, ");
  });

  it("entry values are data: literal braces in content stay literal (#1053)", () => {
    const r = render("{{#bullets}}<i>{{text}}</i>{{/bullets}}", [TEXTS], {
      bullets: bullets("{{Page URL}}"),
    });
    expect(r.html).toContain(">{{Page URL}}</i>");
    expect(r.missingSlots).toEqual([]);
  });
});

describe("lists — shared lists, children, {{>recurse}}", () => {
  it("iterates a shared list and its children by the node's loop name", () => {
    const r = render(
      "{{#menu}}<a>{{label}}</a>{{#children}}<b>{{label}}</b>{{/children}}{{/menu}}",
      [HEADER],
    );
    expect(r.html).toBe(
      `<a data-caelo-list-item="${LIST.header}/${ITEM.home}">Home</a>` +
        `<a data-caelo-list-item="${LIST.header}/${ITEM.about}">About</a><b data-caelo-list-item="${LIST.header}/${ITEM.team}">Team</b>` +
        `<a data-caelo-list-item="${LIST.header}/${ITEM.newsEntry}">News</a>`,
    );
  });

  it("matches a children name that repeats inside itself (balanced)", () => {
    const r = render(
      "{{#menu}}[{{label}}{{#children}}({{label}}{{#children}}!{{/children}}){{/children}}]{{/menu}}",
      [HEADER],
    );
    expect(r.html).toBe("[Home][About(Team)][News]");
  });

  it("{{>recurse}} renders the current entry's children with the enclosing block", () => {
    const r = render(
      "<ul>{{#menu}}<li>{{label}}{{#has_children}}<ul>{{>recurse}}</ul>{{/has_children}}</li>{{/menu}}</ul>",
      [HEADER],
    );
    expect(r.html.replace(/ data-caelo-list-item="[^"]*"/g, "")).toBe(
      "<ul><li>Home</li><li>About<ul><li>Team</li></ul></li><li>News</li></ul>",
    );
  });

  it("{{>recurse}} is bounded: entries deeper than the type's max_depth are refused, not drawn", () => {
    const deep = (n: number): Record<string, unknown> => ({
      id: uuid(100 + n),
      node: "entry",
      values: { label: `L${n}` },
      ...(n < 4 ? { children: [deep(n + 1)] } : {}),
    });
    const fields: TemplateField[] = [{ name: "nav", kind: "list", listType: "menu" }];
    const html = "{{#nav}}<li>{{label}}<ul>{{>recurse}}</ul></li>{{/nav}}";
    // menu: max_depth 3 — three levels render, a fourth is data the type forbids.
    const ok = render(html, fields, { nav: [deep(2)] });
    expect(ok.html.replace(/ data-caelo-list-item="[^"]*"/g, "")).toBe(
      "<li>L2<ul><li>L3<ul><li>L4<ul></ul></li></ul></li></ul></li>",
    );
    const tooDeep = render(html, fields, { nav: [deep(1)] });
    expect(tooDeep.html).toBe(html);
    expect(tooDeep.missingSlots).toEqual([
      "list-malformed:nav[items[0].children[0].children[0].children[0]]",
    ]);
  });

  it("system keys: id node index depth first last", () => {
    const r = render(
      "{{#menu}}{{index}}:{{node}}:{{depth}}:{{#first}}F{{/first}}{{#last}}L{{/last}}{{#children}}/{{depth}}{{id}}{{/children}};{{/menu}}",
      [HEADER],
    );
    expect(r.html).toBe(`0:entry:1:F;1:entry:1:/2${ITEM.team};2:entry:1:L;`);
  });

  it("has_<children> and count_<children>", () => {
    const r = render("{{#menu}}{{count_children}}{{#has_children}}+{{/has_children}},{{/menu}}", [
      HEADER,
    ]);
    expect(r.html).toBe("0,1+,0,");
  });
});

describe("lists — dot access and compound values", () => {
  it("a bare link renders its href, which resolves like any reference", () => {
    const r = render('{{#menu}}<a href="{{link}}">{{link.title}}</a>{{/menu}}', [HEADER]);
    expect(r.html).toContain('href="/about/"');
    expect(r.html).toContain(">About</a>");
    expect(r.missingSlots).toEqual([]);
  });

  it("{{link.href}} and {{link.target}}", () => {
    const fields: TemplateField[] = [{ name: "links", kind: "list", listType: "links" }];
    const r = render(
      '{{#links}}<a href="{{link.href}}" target="{{link.target}}">{{label}}</a>{{/links}}',
      fields,
      {
        links: [
          {
            id: uuid(1),
            node: "link",
            values: { label: "Ext", link: { href: "https://x.test", target: "_blank" } },
          },
        ],
      },
    );
    expect(r.html).toContain('href="https://x.test" target="_blank" data-caelo-list-item=');
    expect(r.html).toContain(">Ext</a>");
  });

  it("a dotted key the value does not have stays raw and is reported", () => {
    const r = render("{{#menu}}{{link.nope}}{{/menu}}", [HEADER]);
    expect(r.html).toContain("{{link.nope}}");
    expect(r.missingSlots).toContain("field-not-declared:menu.link.nope");
  });
});

describe("lists — lookup order: entry, enclosing entries, module fields", () => {
  it("reads an enclosing entry's key and a module field from inside an entry", () => {
    const fields: TemplateField[] = [HEADER, { name: "brand", kind: "text" }];
    const r = render("{{#menu}}{{#children}}{{brand}}>{{label}}<{{/children}}{{/menu}}", fields, {
      brand: "ACME",
    });
    expect(r.html).toContain("ACME>Team<");
  });

  it("the innermost entry wins over an enclosing one", () => {
    const r = render("{{#menu}}{{#children}}{{label}}{{/children}}{{/menu}}", [HEADER]);
    expect(r.html).toContain("Team");
    expect(r.html).not.toContain("About");
  });

  it("a key found nowhere stays raw and pushes field-not-declared:<f>.<key>", () => {
    const r = render("{{#menu}}{{lable}}{{/menu}}", [HEADER]);
    expect(r.html).toContain("{{lable}}");
    expect(r.missingSlots).toContain("field-not-declared:menu.lable");
  });
});

describe("lists — is_current / is_ancestor", () => {
  it("marks the entry linking to the rendering page and its ancestors", () => {
    const r = render(
      "{{#menu}}{{label}}{{#is_current}}*{{/is_current}}{{#is_ancestor}}^{{/is_ancestor}}{{#children}}({{label}}{{#is_current}}*{{/is_current}}){{/children}} {{/menu}}",
      [HEADER],
      {},
      ctx(PAGE.team),
    );
    expect(r.html).toBe("Home About^(Team*) News ");
  });

  it("a page below a menu entry's page makes the entry an ancestor (page tree)", () => {
    const r = render(
      "{{#menu}}{{#is_ancestor}}{{label}}{{/is_ancestor}}{{/menu}}",
      [HEADER],
      {},
      ctx(PAGE.newsA),
    );
    expect(r.html).toBe("News");
  });

  it("a node without its own link is an ancestor of a current entry below it", () => {
    const r = render(
      "{{#mega}}{{#columns}}{{#is_ancestor}}[{{node}}]{{/is_ancestor}}{{/columns}}{{/mega}}",
      [MEGA],
      {},
      ctx(PAGE.team),
    );
    expect(r.html).toBe("[column]");
  });

  it("compares resolved URLs for literal hrefs", () => {
    const fields: TemplateField[] = [{ name: "links", kind: "list", listType: "links" }];
    const r = render(
      "{{#links}}{{#is_current}}{{label}}{{/is_current}}{{/links}}",
      fields,
      {
        links: [
          { id: uuid(1), node: "link", values: { label: "Lit", link: { href: "/about/" } } },
          { id: uuid(2), node: "link", values: { label: "Other", link: { href: "/news" } } },
        ],
      },
      ctx(PAGE.about),
    );
    expect(r.html).toBe("Lit");
  });
});

describe("lists — mega menu: is_<node>, items, select flags, embedded modules", () => {
  const MEGA_HTML =
    "{{#mega}}<li>{{label}}{{#columns}}" +
    '{{#is_column}}<div><h4>{{heading}}</h4>{{#links}}<a href="{{link}}">{{label}}{{#badge_new}} NEW{{/badge_new}}</a>{{/links}}</div>{{/is_column}}' +
    "{{#is_news_feed}}<aside>{{heading}}{{#items}}<p>{{title}}|{{published_at}}</p>{{/items}}</aside>{{/is_news_feed}}" +
    "{{#is_promo}}<section>{{title}}{{>teaser}}</section>{{/is_promo}}" +
    "{{/columns}}</li>{{/mega}}";

  it("renders every node kind of the tree", () => {
    const asked: { key: string; ref: unknown }[] = [];
    const r = render(MEGA_HTML, [MEGA], {}, ctx(), {
      partials: (key, ref) => {
        asked.push({ key, ref });
        return "<em>teaser</em>";
      },
    });
    const html = r.html.replace(/ data-caelo-list-item="[^"]*"/g, "");
    expect(html).toBe(
      "<li>Products" +
        '<div><h4>Explore</h4><a href="/about/team/">Team NEW</a><a href="https://docs.example">Docs</a></div>' +
        "<aside>Latest<p>Meetup|2026-10-05T09:00:00.000Z</p><p>Launch day|2026-10-01T09:00:00.000Z</p></aside>" +
        "<section>Try it<em>teaser</em></section>" +
        "</li>",
    );
    expect(asked).toEqual([
      {
        key: `list:mega/${ITEM.promo}/teaser`,
        ref: { moduleId: MODULE.teaser, contentInstanceId: INSTANCE.teaser },
      },
    ]);
    expect(r.missingSlots).toEqual([]);
  });

  it("without a nested renderer an embedded module stays loud", () => {
    const r = render(
      "{{#mega}}{{#columns}}{{#is_promo}}{{>teaser}}{{/is_promo}}{{/columns}}{{/mega}}",
      [MEGA],
    );
    expect(r.missingSlots).toContain(`nested-renderer-unavailable:mega[${ITEM.promo}].teaser`);
  });

  it("generated entries carry no list-item stamp; items is empty on a node without a source", () => {
    const r = render(
      "{{#mega}}{{#columns}}{{#items}}<p>{{title}}</p>{{/items}}{{/columns}}{{/mega}}",
      [MEGA],
    );
    expect(r.html).toBe("<p>Meetup</p><p>Launch day</p>");
    expect(r.missingSlots).toEqual([]);
  });
});

describe("lists — {{page.*}}", () => {
  it("reads the rendering page's title, props and terms anywhere in a module", () => {
    const r = render(
      "<h1>{{page.title}}</h1>{{page.props.rating}}|{{page.props.event_date.formatted}}|{{#page.terms.tags}}#{{name}}{{/page.terms.tags}}",
      [],
      {},
      ctx(PAGE.newsA),
    );
    expect(r.html).toBe("<h1>Launch day</h1>4|November 2, 2026|#Release");
  });

  it("is loud without a list context", () => {
    const r = render("{{page.title}}", [], {}, null);
    expect(r.html).toBe("{{page.title}}");
    expect(r.missingSlots).toContain("list-context-unavailable:page");
  });

  it("query entries expose summary, image (url/alt) and props", () => {
    const fields: TemplateField[] = [
      {
        name: "latest",
        kind: "list",
        listType: "links",
        bind: "source",
        source: {
          kind: "query",
          editable: [],
          defaults: { page_type: "news", order: "prop_asc:rating", limit: 5 },
        },
      },
    ];
    const r = render(
      '{{#latest}}<img src="{{image}}" alt="{{image.alt}}">{{summary}}|{{props.rating}};{{/latest}}',
      fields,
      {},
      ctx(PAGE.home),
    );
    expect(r.html).toBe(
      '<img src="/_caelo/media/hero" alt="Hero">We launched.|4;<img src="" alt="">|5;',
    );
  });
});

describe("lists — terms", () => {
  it("a term field iterates the vocabulary entries it references", () => {
    const type = {
      name: "chips",
      kind: "list" as const,
      listType: "tags",
      bind: "shared" as const,
      list: `caelo:list/${LIST.tags}`,
    };
    const r = render("{{#chips}}{{name}}/{{slug}} {{/chips}}", [type]);
    expect(r.html).toBe("Release/release Event/event ");
  });

  it("page_terms lists the rendering page's terms", () => {
    const fields: TemplateField[] = [
      {
        name: "tags",
        kind: "list",
        listType: "tags",
        bind: "source",
        source: { kind: "system", name: "page_terms" },
        list: `caelo:list/${LIST.tags}`,
      },
    ];
    expect(render("{{#tags}}{{name}}{{/tags}}", fields, {}, ctx(PAGE.newsB)).html).toBe("Event");
  });

  it("term_pages lists other pages carrying the placement's terms", () => {
    const fields: TemplateField[] = [
      {
        name: "related",
        kind: "list",
        listType: "links",
        bind: "source",
        source: { kind: "system", name: "term_pages" },
      },
    ];
    const r = render(
      "{{#related}}{{title}}{{/related}}",
      fields,
      { related: { terms: [TERM.release, TERM.event] } },
      ctx(PAGE.newsA),
    );
    expect(r.html).toBe("Meetup");
  });
});

describe("lists — plugin sources", () => {
  const SWITCHER =
    '<nav>{{#language_links}}<a href="{{href}}">{{label}}</a>{{/language_links}}</nav>';

  it("an undeclared section name reads an active plugin source", () => {
    const lists = ctx(PAGE.home, {
      pluginSources: {
        language_links: [
          { id: "en", values: { href: "/", label: "English" } },
          { id: "de", values: { href: "/de", label: "Deutsch" } },
        ],
      },
    });
    const r = render(SWITCHER, [], {}, lists);
    expect(r.html).toBe('<nav><a href="/">English</a><a href="/de">Deutsch</a></nav>');
    expect(r.missingSlots).toEqual([]);
  });

  it("an empty plugin source renders nothing — that is data", () => {
    const r = render(SWITCHER, [], {}, ctx(PAGE.home, { pluginSources: { language_links: [] } }));
    expect(r.html).toBe("<nav></nav>");
    expect(r.missingSlots).toEqual([]);
  });

  it("a source of an inactive plugin stays loud and names the plugin", () => {
    const fields: TemplateField[] = [
      {
        name: "comments",
        kind: "list",
        listType: "texts",
        bind: "source",
        source: { kind: "plugin", name: "comments" },
      },
    ];
    const r = render("{{#comments}}x{{/comments}}", fields);
    expect(r.html).toBe("{{#comments}}x{{/comments}}");
    expect(r.missingSlots).toEqual(["list-source-unavailable:comments plugin=comments-plugin"]);
  });

  it("an undeclared name of an inactive plugin's source stays loud and names the plugin", () => {
    const lists = createListRenderContext(fixtureData(), {
      dormantPluginSources: { language_links: "international-site" },
    }).forPage(PAGE.home);
    const r = render(SWITCHER, [], {}, lists);
    expect(r.html).toBe(SWITCHER);
    expect(r.missingSlots).toEqual([
      "list-source-unavailable:language_links plugin=international-site",
    ]);
  });

  it("a module's own field wins over a plugin source of the same name", () => {
    const fields: TemplateField[] = [{ ...TEXTS, name: "language_links" }];
    const r = render(
      "{{#language_links}}{{text}}{{/language_links}}",
      fields,
      {
        language_links: bullets("mine"),
      },
      ctx(PAGE.home, {
        pluginSources: { language_links: [{ id: "x", values: { text: "plugin" } }] },
      }),
    );
    expect(r.html).toBe("mine");
  });
});

describe("lists — loud markers", () => {
  it("list-unbound: a shared field with neither list nor value", () => {
    const r = render("{{#nav}}x{{/nav}}", [
      { name: "nav", kind: "list", listType: "menu", bind: "shared" },
    ]);
    expect(r.html).toBe("{{#nav}}x{{/nav}}");
    expect(r.missingSlots).toEqual(["list-unbound:nav"]);
  });

  it("list-missing: a shared field naming a deleted list", () => {
    const gone = "00000000-0000-4000-8000-999999999999";
    const r = render(
      "{{#nav}}x{{/nav}}",
      [{ name: "nav", kind: "list", listType: "menu", bind: "shared" }],
      {
        nav: `caelo:list/${gone}`,
      },
    );
    expect(r.missingSlots).toEqual([`list-missing:${gone}`]);
  });

  it("list-type-missing: an unknown list type", () => {
    const r = render("{{#x}}y{{/x}}", [{ name: "x", kind: "list", listType: "ghost" }], { x: [] });
    expect(r.missingSlots).toEqual(["list-type-missing:ghost"]);
  });

  it("list-malformed: an entry of an unknown node kind names its path", () => {
    const r = render("{{#bullets}}x{{/bullets}}", [TEXTS], {
      bullets: [{ id: uuid(1), node: "ghost", values: {} }],
    });
    expect(r.missingSlots).toEqual(["list-malformed:bullets[items[0].node]"]);
  });

  it("list-context-unavailable: a list rendered without a list context", () => {
    const r = render("{{#bullets}}x{{/bullets}}", [TEXTS], { bullets: bullets("a") }, null);
    expect(r.html).toBe("{{#bullets}}x{{/bullets}}");
    expect(r.missingSlots).toEqual(["list-context-unavailable:bullets"]);
  });
});
