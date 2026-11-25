// SPDX-License-Identifier: MPL-2.0

/**
 * Template syntax for lists (epic #1107, `docs/lists.md` §8): one test
 * (or more) per syntax row, plus the loud markers. Rendered through the
 * real resolver over the fixture site, so the engine and the resolver
 * are tested as the composer uses them.
 */

import { describe, expect, it } from "bun:test";
import type { FieldDef } from "./lists/fields.js";
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
import type { LoadedPageType } from "./lists/render-data.js";
import { createListRenderContext, type ListPageContext } from "./lists/resolve.js";
import {
  isFieldPathMarker,
  renderTemplate,
  type TemplateField,
  templateFieldsFromJson,
} from "./template-engine.js";

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
    expect(r.missingSlots).toContain("field-path-unknown:menu.link.nope");
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

  // #1561 — one module on pages of several types (a help-page head also on
  // the home page) reads a property only some of the types declare.
  describe("a property the page's own type does not declare (#1561)", () => {
    const pageTypeOf = (slug: string, properties: FieldDef[]): [string, LoadedPageType] => [
      slug,
      {
        id: `00000000-0000-4000-8000-${String(702 + slug.length).padStart(12, "0")}`,
        def: {
          slug,
          name: slug,
          purpose: `${slug} pages.`,
          collection: false,
          templates: ["00000000-0000-4000-8000-000000000801"],
          defaultTemplate: "00000000-0000-4000-8000-000000000801",
          properties,
          vocabularies: [],
        },
      },
    ];
    /**
     * The fixture site plus the `page` type (home, about, …) declaring
     * `intro`, `cta` and the select `layout`; `extraTypes` adds page types,
     * `homeProps` the home page's stored properties.
     */
    const typedCtx = (
      pageId: string,
      opts: {
        readonly extraTypes?: readonly [string, LoadedPageType][];
        readonly homeProps?: Record<string, unknown>;
      } = {},
    ): ListPageContext => {
      const data = fixtureData();
      const pageTypes = new Map(data.pageTypes);
      for (const [slug, t] of [
        pageTypeOf("page", [
          { name: "intro", label: "Intro", type: "text" },
          { name: "cta", label: "CTA", type: "link" },
          { name: "layout", label: "Layout", type: "select", options: ["wide", "narrow"] },
        ]),
        ...(opts.extraTypes ?? []),
      ]) {
        pageTypes.set(slug, t);
      }
      const pages = new Map(data.pages);
      const home = pages.get(PAGE.home);
      if (home && opts.homeProps) pages.set(PAGE.home, { ...home, properties: opts.homeProps });
      return createListRenderContext({ ...data, pageTypes, pages }).forPage(pageId, {
        linkResolver: fixtureLinkIndex().forPage(pageId),
      });
    };
    const LABEL: TemplateField = { name: "label", kind: "text", default: "Rating:" };
    const HEAD =
      "{{#page.props.rating}}<ul><li><b>{{label}}</b> {{page.props.rating}}</li></ul>{{/page.props.rating}}" +
      "{{^page.props.rating}}<p>unrated</p>{{/page.props.rating}}";

    it("is absent when another page type declares it: its section is left out, the inverted one renders", () => {
      const home = render(HEAD, [LABEL], {}, typedCtx(PAGE.home));
      expect(home.html).toBe("<p>unrated</p>");
      expect(home.missingSlots).toEqual([]);
      const news = render(HEAD, [LABEL], {}, typedCtx(PAGE.newsA));
      expect(news.html).toBe("<ul><li><b>Rating:</b> 4</li></ul>");
      expect(news.missingSlots).toEqual([]);
    });

    it("reads as the other type's empty value, paths included", () => {
      const home = render(
        "[{{page.props.rating}}|{{page.props.event_date.formatted}}]",
        [],
        {},
        typedCtx(PAGE.home),
      );
      expect(home.html).toBe("[|]");
      expect(home.missingSlots).toEqual([]);
      const news = render(
        "[{{page.props.cta}}|{{page.props.cta.href}}|{{#page.props.cta}}go{{/page.props.cta}}]",
        [],
        {},
        typedCtx(PAGE.newsA),
      );
      expect(news.html).toBe("[||]");
      expect(news.missingSlots).toEqual([]);
    });

    it("a property no page type declares stays raw and fails, never falsy", () => {
      const html =
        "{{#page.props.ratnig}}<b>{{label}}</b> {{page.props.ratnig}}{{/page.props.ratnig}}";
      for (const pageId of [PAGE.home, PAGE.newsA]) {
        const r = render(html, [LABEL], {}, typedCtx(pageId));
        expect(r.html).toBe(html);
        expect(r.missingSlots).toEqual(["page-prop-unknown:ratnig"]);
      }
      const inverted = render(
        "{{^page.props.ratnig}}unrated{{/page.props.ratnig}}",
        [],
        {},
        typedCtx(PAGE.home),
      );
      expect(inverted.html).toBe("{{^page.props.ratnig}}unrated{{/page.props.ratnig}}");
      expect(inverted.missingSlots).toEqual(["page-prop-unknown:ratnig"]);
      // A path through it names the property, not the key after it.
      const path = render("{{page.props.cta_link.href}}", [], {}, typedCtx(PAGE.home));
      expect(path.html).toBe("{{page.props.cta_link.href}}");
      expect(path.missingSlots).toEqual(["page-prop-unknown:cta_link"]);
      // The preview lists it with what blocks Publish live.
      expect(isFieldPathMarker("page-prop-unknown:ratnig")).toBe(true);
    });

    it("answers a select property's option flags, on its own type and as absent elsewhere", () => {
      const html =
        "{{#page.props.layout_wide}}W{{/page.props.layout_wide}}{{^page.props.layout_wide}}N{{/page.props.layout_wide}}";
      const wide = render(html, [], {}, typedCtx(PAGE.home, { homeProps: { layout: "wide" } }));
      expect(wide.html).toBe("W");
      expect(wide.missingSlots).toEqual([]);
      const narrow = render(html, [], {}, typedCtx(PAGE.home, { homeProps: { layout: "narrow" } }));
      expect(narrow.html).toBe("N");
      expect(narrow.missingSlots).toEqual([]);
      // A news page's type has no `layout`: absent, so the flag is false.
      const news = render(html, [], {}, typedCtx(PAGE.newsA));
      expect(news.html).toBe("N");
      expect(news.missingSlots).toEqual([]);
      // An option the select does not have is unknown on every page.
      for (const pageId of [PAGE.home, PAGE.newsA]) {
        const r = render(
          "{{#page.props.layout_huge}}H{{/page.props.layout_huge}}",
          [],
          {},
          typedCtx(pageId),
        );
        expect(r.missingSlots).toEqual(["page-prop-unknown:layout_huge"]);
      }
    });

    it("answers every path of each type when page types declare the name differently", () => {
      // `event` sorts before `page`, and declares `cta` as text where `page` has a link.
      const extraTypes = [pageTypeOf("event", [{ name: "cta", label: "CTA", type: "text" }])];
      const html =
        "[{{page.props.cta}}|{{page.props.cta.href}}|{{#page.props.cta}}go{{/page.props.cta}}{{^page.props.cta}}none{{/page.props.cta}}]";
      const news = render(html, [], {}, typedCtx(PAGE.newsA, { extraTypes }));
      expect(news.html).toBe("[||none]");
      expect(news.missingSlots).toEqual([]);
    });

    it("query entries read another type's property as absent and an unknown one loudly", () => {
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
      const ok = render(
        "{{#latest}}{{props.rating}}[{{props.intro}}];{{/latest}}",
        fields,
        {},
        typedCtx(PAGE.home),
      );
      expect(ok.html).toBe("4[];5[];");
      expect(ok.missingSlots).toEqual([]);
      const typo = render(
        "{{#latest}}{{props.ratng}};{{/latest}}",
        fields,
        {},
        typedCtx(PAGE.home),
      );
      expect(typo.html).toBe("{{props.ratng}};{{props.ratng}};");
      expect(typo.missingSlots).toContain("page-prop-unknown:ratng");
    });
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

  // #1304 — a stored `modules.fields` jsonb whose query source omits
  // `editable` renders through the parsed source (editable: []), never a
  // raw one the resolver would read `editable` off.
  it("a stored query source without editable renders (#1304)", () => {
    const fields = templateFieldsFromJson([
      {
        name: "latest",
        kind: "list",
        listType: "links",
        bind: "source",
        source: {
          kind: "query",
          defaults: { page_type: "news", order: "prop_asc:rating", limit: 5 },
        },
      },
    ]);
    expect(fields[0]?.source).toEqual({
      kind: "query",
      editable: [],
      defaults: { page_type: "news", order: "prop_asc:rating", limit: 5 },
    });
    const r = render("{{#latest}}{{props.rating}};{{/latest}}", fields, {}, ctx(PAGE.home));
    expect(r.html).toBe("4;5;");
    expect(r.missingSlots).toEqual([]);
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

describe("lists — breadcrumbs and {{site_text.*}} (#1142)", () => {
  const SITE_TEXTS = "00000000-0000-4000-8000-0000000000e1";
  const withTexts = (pageId: string, texts: Record<string, string>): ListPageContext =>
    createListRenderContext(
      fixtureData({
        lists: [
          {
            id: SITE_TEXTS,
            slug: "site-texts",
            name: "Site texts",
            typeSlug: "site-texts",
            items: Object.entries(texts).map(([key, text], i) => ({
              id: uuid(900 + i),
              node: "text",
              values: { key, text },
            })),
          },
        ],
      }),
    ).forPage(pageId, { linkResolver: fixtureLinkIndex().forPage(pageId) });
  const CRUMBS: TemplateField = {
    name: "crumbs",
    kind: "list",
    listType: "links",
    bind: "source",
    source: { kind: "system", name: "breadcrumbs" },
  };
  const NAV =
    '<nav aria-label="{{site_text.breadcrumb_label}}"><ol>{{#crumbs}}<li>{{#is_current}}<span aria-current="page">{{short_title}}</span>{{/is_current}}{{^is_current}}<a href="{{link}}">{{short_title}}</a>{{/is_current}}</li>{{/crumbs}}</ol></nav>';

  it("renders a trail home → current with the aria-label from the site texts", () => {
    const r = render(NAV, [CRUMBS], {}, withTexts(PAGE.team, { breadcrumb_label: "Breadcrumb" }));
    expect(r.html).toBe(
      '<nav aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/about/">About</a></li><li><span aria-current="page">Team</span></li></ol></nav>',
    );
    expect(r.missingSlots).toEqual([]);
  });

  it("a missing site text stays loud", () => {
    const r = render(
      '<nav aria-label="{{site_text.breadcrumb_label}}"></nav>',
      [],
      {},
      withTexts(PAGE.team, {}),
    );
    expect(r.html).toBe('<nav aria-label="{{site_text.breadcrumb_label}}"></nav>');
    expect(r.missingSlots).toContain("site-text-missing:breadcrumb_label");
  });

  it("is loud without a list context", () => {
    const r = render("{{site_text.breadcrumb_label}}", [], {}, null);
    expect(r.missingSlots).toContain("list-context-unavailable:site_text");
  });
});
