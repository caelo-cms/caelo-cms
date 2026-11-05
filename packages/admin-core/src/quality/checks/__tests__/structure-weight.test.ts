// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1371 — page weight and CSS where it is used. The fixture models
 * the migrated site that produced the epic: a header that writes its mega
 * menu once for desktop and once for mobile, a footer with the same menu,
 * a consent banner, and product-only rules in the layout CSS.
 */

import { describe, expect, it } from "bun:test";
import { parseMarkup } from "@caelo-cms/shared";
import type { StagedPage } from "../check.js";
import { findingSchema } from "../findings.js";
import { type StructureLayout, structureFindings } from "../structure.js";
import type { StructureModule } from "../structure-analysis.js";
import { cssRules } from "../structure-css.js";
import type { StructurePageIndex } from "../structure-listing.js";
import { CHROME_ERROR_ELEMENTS, CHROME_WARN_ELEMENTS } from "../structure-weight.js";
import { measurePage, repeatedListRenders } from "../structure-weight-analysis.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LIST = "00000000-0000-4000-9000-000000000001";
const stamp = (n: number) => `${LIST}/00000000-0000-4000-9000-00000000010${n}`;

function mod(n: number, slug: string, over: Partial<StructureModule> = {}): StructureModule {
  return {
    id: id(n),
    slug,
    displayName: slug,
    html: `<section class="${slug}"></section>`,
    js: "",
    css: "",
    kind: "content",
    defaultModuleIds: [],
    listFields: [],
    moduleListFields: [],
    fieldNames: [],
    entryKeys: {},
    ...over,
  };
}

const HEADER = mod(1, "site-header", {
  kind: "chrome",
  html: '<header class="site-header"></header>',
});
const FOOTER = mod(2, "site-footer", {
  kind: "chrome",
  html: '<footer class="site-footer"></footer>',
});
const TEXT = mod(3, "text", { html: '<section class="text"><p>{{body}}</p></section>' });

const LAYOUT_ID = id(90);
function layout(css = "", over: Partial<StructureLayout> = {}): StructureLayout {
  return {
    id: LAYOUT_ID,
    displayName: "Site",
    html: '<div class="shell">{{>header}}{{>main}}{{>footer}}</div>',
    css,
    chromeModuleSlugs: [],
    ...over,
  };
}

const PRODUCT = id(80);
const NEWS = id(81);
function index(
  pages: StagedPage[],
  typeOf: (p: StagedPage) => string = () => NEWS,
): StructurePageIndex {
  return {
    pageTypes: new Map([
      [PRODUCT, { slug: "product", name: "Product", purpose: "", collection: true }],
      [NEWS, { slug: "news", name: "News", purpose: "", collection: true }],
    ]),
    pages: new Map(
      pages.map((p) => [
        p.pageId,
        { pageTypeId: typeOf(p), pageTypeConfirmed: true, title: p.path, path: p.path },
      ]),
    ),
    siteHosts: new Set(),
    variantGroups: new Map(),
    pageLayouts: new Map(pages.map((p) => [p.pageId, LAYOUT_ID])),
  };
}

function page(n: number, path: string, body: string): StagedPage {
  return {
    pageId: id(500 + n),
    path,
    url: `https://staging.example.com${path}`,
    html: `<!doctype html><html><head><title>x</title><link rel="stylesheet" href="/a.css"></head><body><div class="shell">${body}</div></body></html>`,
  };
}

const root = (m: StructureModule, inner: string, tag = "section") =>
  `<${tag} class="${m.slug}" data-caelo-module-id="${m.id}">${inner}</${tag}>`;
const menu = (n = 3) =>
  `<ul>${Array.from({ length: n }, (_, i) => `<li data-caelo-list-item="${stamp(i + 1)}"><a href="/p${i}">P${i}</a></li>`).join("")}</ul>`;
/** `n` elements of filler markup. */
const filler = (n: number) => "<span></span>".repeat(n);

function findings(
  pages: StagedPage[],
  modules: StructureModule[],
  layouts: StructureLayout[] = [layout()],
  pageIndex = index(pages),
) {
  const all = structureFindings(pages, modules, layouts, pageIndex);
  for (const f of all) expect(() => findingSchema.parse(f)).not.toThrow();
  return all;
}
const only = (rule: string, list: ReturnType<typeof findings>) =>
  list.filter((f) => f.ruleId === `structure/${rule}`);

describe("measurePage", () => {
  it("counts body elements per part, SVG children included, template contents excluded", () => {
    const html =
      '<html><head><meta charset="utf-8"></head><body><div class="shell">' +
      `<header data-caelo-module-id="${HEADER.id}"><svg class="ico"><path d="M0"/><path d="M1"/></svg><img src="/a.png"></header>` +
      '<div data-caelo-plugin="consent-manager"><p>Cookies</p></div>' +
      `<section data-caelo-module-id="${TEXT.id}"><template><div class="later"><b></b></div></template></section>` +
      "</div></body></html>";
    const { weight, classes } = measurePage("p", "/", html);
    expect(weight.parts.get(`module:${HEADER.id}`)).toEqual({ elements: 5, svg: 3 });
    expect(weight.parts.get("plugin:consent-manager")).toEqual({ elements: 2, svg: 0 });
    // The <template> is an element; what it holds is not in the DOM yet.
    expect(weight.parts.get(`module:${TEXT.id}`)).toEqual({ elements: 2, svg: 0 });
    expect(weight.parts.get("layout")).toEqual({ elements: 1, svg: 0 });
    // …but its classes render once a script clones it.
    expect(classes.has("later")).toBe(true);
    expect(classes.has("ico")).toBe(true);
  });

  it("nested modules count toward their outermost placement", () => {
    const html = `<body><div data-caelo-module-id="${HEADER.id}"><nav data-caelo-module-id="${TEXT.id}"><a></a></nav></div></body>`;
    const { weight } = measurePage("p", "/", html);
    expect([...weight.parts.keys()]).toEqual([`module:${HEADER.id}`]);
    expect(weight.parts.get(`module:${HEADER.id}`)?.elements).toBe(3);
  });
});

describe("repeatedListRenders", () => {
  it("counts copies per module, not per entry, and one module's repeated roots once", () => {
    const card = mod(4, "card");
    const html =
      root(HEADER, `<nav>${menu()}</nav><div class="mobile">${menu()}</div>`, "header") +
      root(FOOTER, menu(), "footer") +
      root(TEXT, `${root(card, menu())}${root(card, menu())}`);
    const renders = repeatedListRenders("p", "/", parseMarkup(html));
    expect(renders).toHaveLength(1);
    expect(renders[0]?.renders).toBe(4);
    expect(renders[0]?.byModule.get(HEADER.id)).toBe(2);
    expect(renders[0]?.byModule.get(FOOTER.id)).toBe(1);
    expect(renders[0]?.byModule.get(card.id)).toBe(1);
  });

  it("one module placed twice writes the list twice, but not twice in one root", () => {
    const html = root(TEXT, menu()) + root(TEXT, menu());
    const renders = repeatedListRenders("p", "/", parseMarkup(html));
    expect(renders[0]?.byModule.get(TEXT.id)).toBe(2);
    expect(renders[0]?.inOneRoot.get(TEXT.id)).toBe(1);
    const f = only("repeated-render", findings([page(1, "/", html)], [TEXT]));
    expect(f.map((x) => x.severity)).toEqual(["warning"]);
    expect(f[0]?.message).not.toContain("on its own");
  });

  it("local lists count inside one module only", () => {
    const local = (n: number) =>
      `<li data-caelo-list-item="local/links/${stamp(n).slice(37)}"></li>`;
    const html = root(HEADER, `<ul>${local(1)}${local(2)}</ul><ul>${local(1)}${local(2)}</ul>`);
    const renders = repeatedListRenders("p", "/", parseMarkup(html));
    expect(renders.map((r) => [r.list, r.renders])).toEqual([[`local:${HEADER.id}:links`, 2]]);
  });
});

describe("structure/repeated-render", () => {
  it("a header writing its menu for desktop and for mobile is an error naming the module", () => {
    const html = root(HEADER, `<nav>${menu()}</nav><div class="drawer">${menu()}</div>`, "header");
    const f = only("repeated-render", findings([page(1, "/", html)], [HEADER]));
    expect(f.map((x) => x.severity)).toEqual(["error"]);
    expect(f[0]?.message).toContain(`caelo:list/${LIST}`);
    expect(f[0]?.message).toContain("render(s) it twice on its own");
    expect(f[0]?.fix?.hint).toContain("mobile-nav");
  });

  it("header + footer showing one shared list warn; a third render blocks", () => {
    const two = root(HEADER, menu(), "header") + root(FOOTER, menu(), "footer");
    const warn = only("repeated-render", findings([page(1, "/", two)], [HEADER, FOOTER]));
    expect(warn.map((x) => x.severity)).toEqual(["warning"]);
    expect(warn[0]?.fix?.hint).toContain("its own short shared list");

    const three = two + root(TEXT, menu());
    const err = only("repeated-render", findings([page(1, "/", three)], [HEADER, FOOTER, TEXT]));
    expect(err.map((x) => x.severity)).toEqual(["error"]);
  });

  describe("#1448 a module's own list is the content instance's", () => {
    const FACTS = mod(4, "split", { html: '<section class="split"></section>' });
    const INSTANCE_A = "00000000-0000-4000-9000-00000000000a";
    const INSTANCE_B = "00000000-0000-4000-9000-00000000000b";
    const INSTANCE_C = "00000000-0000-4000-9000-00000000000c";
    const ITEM = (n: number) => `00000000-0000-4000-9000-00000000020${n}`;
    const facts = (instance: string, ...items: number[]) =>
      `<ul>${items.map((n) => `<li data-caelo-list-item="instance/${instance}/facts/${ITEM(n)}">F${n}</li>`).join("")}</ul>`;

    it("two or three placements with their own instances are no repeated list", () => {
      const two = root(FACTS, facts(INSTANCE_A, 1, 2)) + root(FACTS, facts(INSTANCE_B, 3, 4, 5));
      expect(only("repeated-render", findings([page(1, "/", two)], [FACTS]))).toEqual([]);
      const three = two + root(FACTS, facts(INSTANCE_C, 6));
      expect(only("repeated-render", findings([page(1, "/", three)], [FACTS]))).toEqual([]);
    });

    it("one instance placed twice is the same list written twice", () => {
      const html = root(FACTS, facts(INSTANCE_A, 1, 2)) + root(FACTS, facts(INSTANCE_A, 1, 2));
      const f = only("repeated-render", findings([page(1, "/", html)], [FACTS]));
      expect(f.map((x) => x.severity)).toEqual(["warning"]);
      expect(f[0]?.message).toContain("local list `facts`");
      expect(f[0]?.message).toContain(INSTANCE_A);
    });

    it("one instance placed three times blocks; another instance on the page does not count", () => {
      const a = root(FACTS, facts(INSTANCE_A, 1));
      const html = a + a + root(FACTS, facts(INSTANCE_B, 2)) + a;
      const f = only("repeated-render", findings([page(1, "/", html)], [FACTS]));
      expect(f.map((x) => x.severity)).toEqual(["error"]);
      expect(f[0]?.message).toContain("rendered 3 times");
    });

    it("one root writing an instance's list twice stays an error", () => {
      const html = root(FACTS, facts(INSTANCE_A, 1, 2) + facts(INSTANCE_A, 1, 2));
      const f = only("repeated-render", findings([page(1, "/", html)], [FACTS]));
      expect(f.map((x) => x.severity)).toEqual(["error"]);
      expect(f[0]?.message).toContain("render(s) it twice on its own");
    });

    it("a field default list has no instance: two placements write the same entries", () => {
      const defaults = `<ul><li data-caelo-list-item="local/facts/${ITEM(1)}">F</li></ul>`;
      const html = root(FACTS, defaults) + root(FACTS, defaults);
      const f = only("repeated-render", findings([page(1, "/", html)], [FACTS]));
      expect(f.map((x) => x.severity)).toEqual(["warning"]);
      expect(f[0]?.message).toContain("local list `facts`");
    });
  });

  it("a list rendered once per page is silent", () => {
    const html = root(HEADER, menu(), "header");
    expect(
      only("repeated-render", findings([page(1, "/", html), page(2, "/a", html)], [HEADER])),
    ).toEqual([]);
  });
});

describe("structure/heavy-chrome", () => {
  const pageWith = (n: number, frame: number, content: number) =>
    page(n, `/p${n}`, root(HEADER, filler(frame - 1), "header") + root(TEXT, filler(content - 1)));

  it("warns from the warn threshold and blocks from the error threshold, per frame", () => {
    const warn = only(
      "heavy-chrome",
      findings([pageWith(1, CHROME_WARN_ELEMENTS, 50)], [HEADER, TEXT]),
    );
    expect(warn.map((x) => x.severity)).toEqual(["warning"]);
    // + the shell div of the layout
    expect(warn[0]?.message).toContain(`${CHROME_WARN_ELEMENTS + 1} elements on every page`);
    expect(warn[0]?.message).toContain("more than the page content itself (50 on average)");
    expect(warn[0]?.message).toContain(`"site-header" (${HEADER.id}) ${CHROME_WARN_ELEMENTS}`);

    const err = only(
      "heavy-chrome",
      findings([pageWith(1, CHROME_ERROR_ELEMENTS, 600), pageWith(2, 300, 600)], [HEADER, TEXT]),
    );
    expect(err.map((x) => x.severity)).toEqual(["error"]);
    expect(err[0]?.message).toContain("on 2 page(s)");
    expect(err[0]?.message).not.toContain("more than the page content");
  });

  it("content modules never count, however heavy", () => {
    const html = root(HEADER, filler(20), "header") + root(TEXT, filler(900));
    expect(only("heavy-chrome", findings([page(1, "/", html)], [HEADER, TEXT]))).toEqual([]);
  });

  it("a module placed in a layout block or on nearly every page is frame without kind chrome", () => {
    const banner = mod(5, "promo-banner");
    const pages = Array.from({ length: 5 }, (_, i) =>
      page(i, `/p${i}`, root(banner, filler(CHROME_WARN_ELEMENTS))),
    );
    expect(only("heavy-chrome", findings(pages, [banner])).length).toBe(1);
    const viaLayout = only(
      "heavy-chrome",
      findings(pages.slice(0, 1), [banner], [layout("", { chromeModuleSlugs: ["promo-banner"] })]),
    );
    expect(viaLayout.length).toBe(1);
    // One page with the banner is not "nearly every page".
    expect(only("heavy-chrome", findings(pages.slice(0, 1), [banner]))).toEqual([]);
  });

  it("a frame module that renders a sub-module as its first element still counts it", () => {
    // tagModuleId keeps the sub-module's stamp on the shared first element,
    // so the header has no root of its own; its field defaults name the nav.
    const nav = mod(9, "mega-nav");
    const header = { ...HEADER, defaultModuleIds: [nav.id] };
    const html = root(nav, filler(CHROME_ERROR_ELEMENTS), "nav") + root(TEXT, "<p></p>");
    const f = only("heavy-chrome", findings([page(1, "/", html)], [header, nav, TEXT]));
    expect(f.map((x) => x.severity)).toEqual(["error"]);
    expect(f[0]?.message).toContain(`"mega-nav" (${nav.id})`);
  });

  it("reports the inline SVG share", () => {
    const icons = '<svg><path d="a"/><path d="b"/><path d="c"/></svg>'.repeat(70);
    const f = only(
      "heavy-chrome",
      findings([page(1, "/", root(HEADER, icons, "header"))], [HEADER]),
    );
    expect(f[0]?.message).toContain("(280 inside inline SVG)");
  });
});

describe("structure/unused-css", () => {
  it("names layout and module classes nothing renders", () => {
    const text = mod(3, "text", {
      html: '<section class="text {{#dark}}is-dark{{/dark}}"><p>{{body}}</p></section>',
      css: ".text{margin:0}.is-dark{color:#fff}.text .legacy-quote{font-style:italic}.is-open{display:block}.is-ready{opacity:1}.caelo-hidden{display:none}",
      js: "el.classList.toggle('is-open'); el.className = 'is-ready'; var legacyQuote = 'legacy-quote'; console.log(legacyQuote);",
    });
    const pages = [page(1, "/", root(text, "<p>Hi</p>"))];
    const f = only(
      "unused-css",
      findings(pages, [text], [layout(".shell{display:grid} .old-hero{padding:0}")]),
    );
    expect(f.map((x) => x.fix?.tool)).toEqual(["propose_update_layout", "update_modules_many"]);
    expect(f[0]?.message).toContain(".old-hero");
    expect(f[0]?.message).not.toContain(".shell");
    // Optional template class, script-set classes and platform class are used;
    // an unrelated string that happens to spell a class name is not.
    expect(f[1]?.message).toContain(".legacy-quote");
    expect(f[1]?.message).not.toMatch(/is-dark|is-open|is-ready|caelo-hidden/);
  });

  /** The classes an unused-css message names. */
  const named = (message: string | undefined) =>
    [...(message ?? "").matchAll(/\.([a-zA-Z0-9_-]+)(?=[,\s])/g)].map((x) => x[1]);

  describe("#1445 classes the module's JS writes", () => {
    /** The classes of `css` reported for a module with this `js`. */
    const reported = (css: string, js: string) => {
      const m = mod(3, "fx", { html: '<section class="fx"></section>', css, js });
      return named(only("unused-css", findings([page(1, "/", root(m, ""))], [m]))[0]?.message);
    };

    it("markup in a string literal, escaped quotes and single quotes alike", () => {
      const js = String.raw`
        function MEADOW(){return "<svg viewBox=\"0 0 9 9\"><g class=\"u-root u-body\"><path class='u-ear'/></g></svg>"}
        document.body.insertAdjacentHTML("beforeend", MEADOW());`;
      expect(reported(".u-root{x:1}.u-body{x:1}.u-ear{x:1}.u-dead{x:1}", js)).toEqual(["u-dead"]);
    });

    it("innerHTML templates: a template literal and a concatenation, around an expression", () => {
      const js = [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source under test.
        'el.innerHTML = `<div class="tr-sum ${x} tr-scroll">${y}</div>`;',
        "out.innerHTML = '<span class=\"iss ' + sev + ' tr-tab\">' + n + '</span>';",
      ].join("\n");
      expect(
        reported(".tr-sum{x:1}.tr-scroll{x:1}.iss{x:1}.tr-tab{x:1}.tr-agents{x:1}", js),
      ).toEqual(["tr-agents"]);
    });

    it("a conditional picks the class, in className and inside markup", () => {
      const js = [
        'li.className = i + 1 < n ? "done" : (i < n ? "now" : "");',
        "el.innerHTML = '<b class=\"' + (ok ? 'good' : 'bad') + '\"></b>';",
        "el.setAttribute('class', on && 'lit');",
        "el.classList.add(on ? 'open' : 'shut');",
      ].join("\n");
      expect(
        reported(
          ".done{x:1}.now{x:1}.good{x:1}.bad{x:1}.lit{x:1}.open{x:1}.shut{x:1}.gone{x:1}",
          js,
        ),
      ).toEqual(["gone"]);
    });

    it("a conditional glued to a prefix builds the class", () => {
      const js = "el.className = 'card--' + (dark ? 'dark' : 'light');";
      expect(reported(".card--dark{x:1}.card--light{x:1}.tile{x:1}", js)).toEqual(["tile"]);
    });

    it("a constant holding the class", () => {
      const js = "const OPEN = 'is-open'; function f(el){ el.classList.add(OPEN); }";
      expect(reported(".is-open{x:1}.is-shut{x:1}", js)).toEqual(["is-shut"]);
    });

    it("a constant declared first and used inside markup", () => {
      const js = "const C = 'row-a'; el.innerHTML = '<b class=\"' + C + '\"></b>';";
      expect(reported(".row-a{x:1}.row-b{x:1}", js)).toEqual(["row-b"]);
    });

    it("an attribute that only ends in class, or holds it in its value, is no class", () => {
      const js = [
        "a.innerHTML = '<div data-class=\"ghost\"></div>';",
        "b.innerHTML = '<div aria-label=\\'class=\"ghost\"\\'></div>';",
      ].join("\n");
      expect(reported(".ghost{x:1}", js)).toEqual(["ghost"]);
    });

    it("text in template literals counts toward the bound too", () => {
      const big = "x".repeat(32 * 1024);
      const chain = Array.from({ length: 40 }, (_, i) => `var a${i + 1} = a${i} + a${i};`);
      const js = `var a0 = \`${big}\`;${chain.join("")}el.className = a40;`;
      const started = performance.now();
      expect(reported(".gone{x:1}", js)).toEqual(["gone"]);
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it("variables that double their text cannot hang the audit", () => {
      const chain = Array.from({ length: 80 }, (_, i) => `var a${i + 1} = a${i} + a${i};`);
      const js = `var a0 = 'x';${chain.join("")}el.className = a80;`;
      expect(reported(".gone{x:1}", js)).toEqual(["gone"]);
    });

    it("a class a script glues from a prefix counts like one a template glues", () => {
      expect(reported(".st-0{x:1}.other{x:1}", "el.className = 'st-' + n;")).toEqual(["other"]);
    });

    it("text that only spells the class proves nothing", () => {
      const js = [
        "// the .ghost card used to be here",
        "var name = 'ghost';",
        "console.log('class ghost was removed', name);",
        "var doc = '<p>ghost</p>';",
      ].join("\n");
      expect(reported(".ghost{x:1}", js)).toEqual(["ghost"]);
    });
  });

  describe("#1445 classes built from a field", () => {
    const reported = (html: string, css: string) => {
      const m = mod(3, "stat", { html, css });
      return named(only("unused-css", findings([page(1, "/", root(m, ""))], [m]))[0]?.message);
    };

    it('class="s{{field}}": a value no placement uses yet is still a value of the field', () => {
      const html = '<i class="st s{{status_group}}"></i>';
      expect(reported(html, ".st{x:1}.s0{x:1}.s2{x:1}")).toEqual([]);
    });

    it("a prefix or a suffix with a separator, also inside a section", () => {
      const html =
        '<i class="card--{{tone}} {{#on}}size-{{size}}{{/on}}"></i>{{#rows}}<b class="{{kind}}-row"></b>{{/rows}}';
      expect(reported(html, ".card--dark{x:1}.size-l{x:1}.warn-row{x:1}.card{x:1}")).toEqual([
        "card",
      ]);
    });

    it("the field's text does not reach into an unrelated class", () => {
      // `s{{x}}` renders s0, s1; no field value spells .sidebar.
      expect(reported('<i class="s{{x}}"></i>', ".sidebar{x:1}.s1{x:1}")).toEqual(["sidebar"]);
    });

    it("every fixed part of a class with several fields must match, in order", () => {
      const html = '<i class="card--{{tone}}-icon-{{size}}"></i>';
      expect(
        reported(html, ".card--dark-icon-l{x:1}.card--removed{x:1}.card--l-icon{x:1}"),
      ).toEqual(["card--removed", "card--l-icon"]);
    });

    it("no fixed start or end proves nothing, whatever sits between two fields", () => {
      expect(reported('<i class="{{a}}-{{b}}"></i>', ".dead-rule{x:1}")).toEqual(["dead-rule"]);
    });

    it("a class that is only a field could be anything, so it proves nothing", () => {
      expect(reported('<i class="{{variant}}"></i>', ".legacy{x:1}")).toEqual(["legacy"]);
    });

    it("layout css for a class a placed module builds from a field", () => {
      const m = mod(3, "stat", { html: '<i class="tone-{{tone}}"></i>' });
      const f = only(
        "unused-css",
        findings([page(1, "/", root(m, ""))], [m], [layout(".tone-red{x:1}.old-hero{x:1}")]),
      );
      expect(f.map((x) => named(x.message))).toEqual([["old-hero"]]);
    });
  });

  it("unplaced modules ship no CSS and are not reported", () => {
    const unplaced = mod(6, "unplaced", { css: ".ghost{color:red}" });
    expect(only("unused-css", findings([page(1, "/", "")], [unplaced]))).toEqual([]);
  });
});

describe("structure/page-specific-layout-css", () => {
  const specA = mod(7, "spec-a", {
    html: '<div class="spec-a"><table class="spec-table"></table></div>',
  });
  const specB = mod(8, "spec-b", {
    html: '<div class="spec-b"><table class="spec-table"></table></div>',
  });
  const css = ".shell{display:grid} .spec-table{width:100%}";

  it("warns for layout CSS several modules use on fewer than half the pages, naming the page types", () => {
    const pages = [
      page(1, "/p/a", root(specA, '<table class="spec-table"></table>')),
      page(2, "/p/b", root(specB, '<table class="spec-table"></table>')),
      ...Array.from({ length: 6 }, (_, i) => page(10 + i, `/news/${i}`, "<p></p>")),
    ];
    const typed = index(pages, (p) => (p.path.startsWith("/p/") ? PRODUCT : NEWS));
    const f = only(
      "page-specific-layout-css",
      findings(pages, [specA, specB], [layout(css)], typed),
    );
    expect(f.map((x) => x.severity)).toEqual(["warning"]);
    expect(f[0]?.message).toContain(".spec-table (2 of 8 pages: Product)");
  });

  it("is silent when the class is on most pages or the layout has few pages", () => {
    const most = Array.from({ length: 6 }, (_, i) =>
      page(i, `/p/${i}`, root(i % 2 ? specA : specB, '<table class="spec-table"></table>')),
    );
    expect(only("page-specific-layout-css", findings(most, [specA, specB], [layout(css)]))).toEqual(
      [],
    );
    const few = most.slice(0, 2).concat([page(9, "/x", "")]);
    expect(only("page-specific-layout-css", findings(few, [specA, specB], [layout(css)]))).toEqual(
      [],
    );
  });
});

describe("structure/duplicate-css", () => {
  const block = "{display:inline-flex; padding: .5rem 1rem;border-radius:999px}";
  const withCss = (n: number, css: string) => mod(n, `m${n}`, { css });

  it("warns when 3+ placed modules describe the same declaration block", () => {
    const mods = [
      withCss(11, `.m11 .btn${block}`),
      withCss(12, `.m12 .cta ${block.replace("; ", ";")}`),
      withCss(13, `.m13 a{border-radius:999px;padding:.5rem 1rem;display:inline-flex}`),
    ];
    const pages = [page(1, "/", mods.map((m) => root(m, "")).join(""))];
    const f = only("duplicate-css", findings(pages, mods));
    expect(f.map((x) => x.severity)).toEqual(["warning"]);
    expect(f[0]?.message).toContain("the same 1 rule block(s)");
  });

  it("two modules, a short block or another media context stay silent", () => {
    const mods = [
      withCss(11, `.a${block}`),
      withCss(12, `.b${block}`),
      withCss(13, `@media (min-width: 40em){.c${block}}`),
      withCss(14, ".d{display:block;color:red}"),
      withCss(15, ".e{display:block;color:red}"),
      withCss(16, ".f{display:block;color:red}"),
    ];
    const pages = [page(1, "/", mods.map((m) => root(m, "")).join(""))];
    expect(only("duplicate-css", findings(pages, mods))).toEqual([]);
  });
});

describe("cssRules", () => {
  it("reads rules at the top level and in grouping at-rules, skipping keyframes and comments", () => {
    const rules = cssRules(
      "/* x{} */ .a{color:red} @media (min-width: 1px){ .b{color:blue} } @keyframes k{from{opacity:0}} .c{content:'}'}",
    );
    expect(rules.map((r) => [r.context, r.selector])).toEqual([
      ["", ".a"],
      ["@media (min-width: 1px)|", ".b"],
      ["", ".c"],
    ]);
  });
});
