// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1198 — the module-JS rules of the structure check. The fixture
 * models the migration that produced the issue: the site header's JS
 * carried the menu AND the demo form's submit, the checklist filter and a
 * scroll reveal, because the header loads on every page.
 */

import { describe, expect, it } from "bun:test";
import type { StagedPage } from "../check.js";
import { findingSchema } from "../findings.js";
import { analyseModuleJs } from "../module-js-analysis.js";
import { foreignHooks, hookOwners } from "../module-js-hooks.js";
import { type StructureLayout, structureFindings } from "../structure.js";
import type { StructureModule } from "../structure-analysis.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const MENU_JS = `(function () {
  document.querySelectorAll('.site-header .mega-toggle').forEach(function (b) {
    b.addEventListener('click', function () {
      var open = b.getAttribute('aria-expanded') === 'true';
      b.setAttribute('aria-expanded', String(!open));
      b.querySelector('.mega-label').textContent = open ? 'Menü öffnen' : 'Menü schließen';
    });
  });
})();`;

const DEMO_JS = `(function () {
  var FORM = '.demo-form';
  document.querySelectorAll(FORM).forEach(function (f) {
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      fetch('https://intgateway.example.com/crm', { method: 'POST', body: new FormData(f) });
    });
  });
})();`;

const REVEAL_JS = `(function () {
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) e.target.classList.add('is-visible'); });
  });
  document.querySelectorAll('[data-reveal]').forEach(function (el) { io.observe(el); });
})();`;

function mod(n: number, displayName: string, html: string, js = ""): StructureModule {
  return { id: id(n), slug: displayName.toLowerCase().replace(/\W+/g, "-"), displayName, html, js };
}

const HEADER_HTML =
  '<header class="site-header"><nav><button class="mega-toggle"><span class="mega-label">Menü</span></button></nav></header>';
const DEMO = mod(
  2,
  "Demo form",
  '<section class="demo" data-reveal><form class="demo-form"><input name="email"></form></section>',
);
const HERO = mod(
  3,
  "Hero with demo form",
  '<section class="hero" data-reveal><form class="demo-form"><input name="email"></form></section>',
);
const TEXT = mod(4, "Text", '<section class="prose" data-reveal><div>{{body}}</div></section>');

function placed(m: StructureModule, inner = ""): string {
  return m.html.replace(/^<(\w+)/, `<$1 data-caelo-module-id="${m.id}"`).replace("{{body}}", inner);
}

function page(n: number, path: string, ...modules: string[]): StagedPage {
  return {
    pageId: id(900 + n),
    path,
    url: `http://s.test${path}`,
    html: `<!doctype html><html><body><div class="shell">${modules.join("")}</div></body></html>`,
  };
}

const noLayouts: StructureLayout[] = [];

function jsFindings(pages: StagedPage[], modules: StructureModule[], layouts = noLayouts) {
  return structureFindings(pages, modules, layouts).filter((f) =>
    /module-js|js-rendered|js-written/.test(f.ruleId),
  );
}

describe("analyseModuleJs — hooks", () => {
  it("reads selectors from calls, constants and the bare id / class arguments", () => {
    const facts = analyseModuleJs(`
      const SEL = '.filter-list [data-filter]';
      document.querySelectorAll(SEL);
      document.getElementById('alert-mail');
      document.getElementsByClassName('watch-card watch-card--on');
      el.closest('a[href="#top"]');
    `);
    expect(facts.hooks).toEqual([
      "#alert-mail",
      ".filter-list",
      ".watch-card",
      ".watch-card--on",
      "[data-filter]",
    ]);
  });

  it("reads the site-wide declaration and its reason", () => {
    expect(
      analyseModuleJs(`/* caelo:site-wide: scroll reveal on every section */\n${REVEAL_JS}`)
        .siteWide,
    ).toBe("scroll reveal on every section");
    expect(analyseModuleJs(REVEAL_JS).siteWide).toBeNull();
  });

  it("yields nothing for empty or unparseable JS (the write refuses the latter)", () => {
    expect(analyseModuleJs("").hooks).toEqual([]);
    expect(analyseModuleJs("function (").hooks).toEqual([]);
  });
});

describe("analyseModuleJs — content", () => {
  it("a mega menu rendered from a JS array is rendered content", () => {
    const facts = analyseModuleJs(`(function () {
      var items = [
        { label: 'Produkte', href: '/produkte' },
        { label: 'Preise', href: '/preise' },
        { label: 'Über uns', href: '/ueber-uns' },
      ];
      var ul = document.querySelector('.mega-list');
      ul.innerHTML = items.map(function (i) { return '<li><a href="' + i.href + '">' + i.label + '</a></li>'; }).join('');
    })();`);
    expect(facts.rendersContent).toHaveLength(2);
    expect(facts.rendersContent.join(" ")).toContain("renders 3 entries from a JS array");
    expect(facts.rendersContent.join(" ")).toContain("links");
  });

  it("markup with text or interpolated data written into the page is rendered content", () => {
    expect(
      analyseModuleJs(`el.insertAdjacentHTML('beforeend', '<p>Jetzt kostenlos testen</p>');`)
        .rendersContent,
    ).toHaveLength(1);
    expect(
      analyseModuleJs(`list.innerHTML = rows.map((r) => \`<li>\${r.name}</li>\`).join('');`)
        .rendersContent,
    ).toHaveLength(1);
  });

  it("showing, hiding, clearing, moving markup and short labels are fine", () => {
    const facts = analyseModuleJs(`
      ${MENU_JS}
      panel.hidden = !panel.hidden;
      list.innerHTML = '';
      copy.innerHTML = source.innerHTML;
      icon.innerHTML = '<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>';
      close.innerHTML = '<span class="sr-only">Close</span>';
      count.textContent = String(n) + ' Treffer';
      var events = ['Click Menu', 'Open Panel', 'Close Panel'];
      track(events);
    `);
    expect(facts.rendersContent).toEqual([]);
    expect(facts.writesText).toEqual([]);
  });

  it("an array of labels is not content when the script writes nothing to the page", () => {
    const facts = analyseModuleJs(
      `var steps = ['Firma', 'Kontakt', 'Termin']; console.log(steps);`,
    );
    expect(facts.rendersContent).toEqual([]);
  });

  it("long literal text written into textContent is written text", () => {
    const facts = analyseModuleJs(
      `note.textContent = 'Vielen Dank für Ihre Anfrage, wir melden uns innerhalb eines Werktags bei Ihnen.';`,
    );
    expect(facts.rendersContent).toEqual([]);
    expect(facts.writesText).toHaveLength(1);
  });
});

describe("Codex review on #1199", () => {
  it("reordering existing elements by id is not rendered content", () => {
    const facts = analyseModuleJs(
      "['card-one', 'card-two', 'card-three'].forEach(function (id) { list.appendChild(document.getElementById(id)); });",
    );
    expect(facts.rendersContent).toEqual([]);
  });

  it("markup kept in a string constant is read like the literal", () => {
    const facts = analyseModuleJs(
      "const markup = '<p>Discover our latest products</p>';\npanel.innerHTML = markup;",
    );
    expect(facts.rendersContent).toHaveLength(1);
  });

  it("unquoted class and id attributes are the template's own hooks", () => {
    const owners = hookOwners([
      { id: id(7), html: "<section class=hero id=top><h1>{{t}}</h1></section>" },
    ]);
    expect(owners.get(".hero")).toEqual(new Set([id(7)]));
    expect(owners.get("#top")).toEqual(new Set([id(7)]));
  });

  it("a class inside :not() is excluded, not driven", () => {
    const owners = hookOwners([
      { id: id(8), html: '<div class="product"></div>' },
      { id: id(9), html: '<div class="admin-only"></div>' },
    ]);
    const facts = analyseModuleJs("document.querySelectorAll('.product:not(.admin-only)');");
    expect(facts.hooks).toEqual([".product"]);
    expect(foreignHooks(facts, new Set([id(8)]), owners).specific.size).toBe(0);
  });
});

describe("Codex re-review on #1199", () => {
  it("an SVG sprite reference is decoration, not a link", () => {
    const facts = analyseModuleJs(
      `icon.innerHTML = '<svg aria-hidden="true"><use href="#icon-menu"></use></svg>';`,
    );
    expect(facts.rendersContent).toEqual([]);
  });

  it("another function's variable of the same name is a different array", () => {
    const facts = analyseModuleJs(`
      (function () { var items = ['Open Menu', 'Close Menu', 'Submit Form']; track(items); })();
      (function () { var items = document.querySelectorAll('.card'); items.forEach(function (el) { list.appendChild(el); }); })();
    `);
    expect(facts.rendersContent).toEqual([]);
  });

  it("a module without a stamped root is checked by the script the page ships", () => {
    const utility = mod(
      30,
      "Promo injector",
      "",
      "document.body.insertAdjacentHTML('beforeend', '<p>Discover our latest products</p>');",
    );
    const bundled: StagedPage = {
      ...page(1, "/"),
      html: `<!doctype html><html><body><main></main><script defer data-source="modules">\n${utility.js}\n</script></body></html>`,
    };
    const encoded: StagedPage = {
      ...page(2, "/b"),
      html: `<!doctype html><html><body><script defer data-source="modules" src="data:text/javascript;base64,${Buffer.from(utility.js).toString("base64")}"></script></body></html>`,
    };
    const deferred: StagedPage = {
      ...page(3, "/c"),
      html: `<!doctype html><html><body><script type="text/plain" data-caelo-deferred-script="${utility.id}">x</script></body></html>`,
    };
    for (const p of [bundled, encoded, deferred]) {
      expect(jsFindings([p], [utility]).map((f) => f.ruleId)).toEqual([
        "structure/js-rendered-content",
      ]);
    }
    expect(jsFindings([page(4, "/d")], [utility])).toEqual([]);
  });
});

describe("Codex round 3 on #1199", () => {
  it("concatenated markup is read in source order", () => {
    const facts = analyseModuleJs(
      `icon.innerHTML = '<svg><use href="#' + 'icon-menu' + '"></use></svg>';`,
    );
    expect(facts.rendersContent).toEqual([]);
  });

  it("reading an array's length or membership renders none of its entries", () => {
    const facts = analyseModuleJs(
      "const events = ['Open Menu', 'Close Menu', 'Submit Form'];\ncount.textContent = events.length;\nflag.hidden = !events.includes(x);",
    );
    expect(facts.rendersContent).toEqual([]);
    const indexed = analyseModuleJs(
      "const labels = ['Open Menu', 'Close Menu', 'Submit Form'];\nbtn.textContent = labels[i];",
    );
    expect(indexed.rendersContent).toHaveLength(1);
  });

  it("FormData / URLSearchParams.append are request data, not page writes", () => {
    const facts = analyseModuleJs(`
      const payload = new FormData();
      payload.append('html', '<p>Contact request details</p>');
      payload.append('note', 'Bitte rufen Sie mich morgen zwischen neun und zwölf Uhr zurück, danke.');
      url.searchParams.append('q', 'Alle Werkzeuge für technisches SEO und Monitoring');
      new URLSearchParams().append('a', '<p>Some long request text here</p>');
    `);
    expect(facts.rendersContent).toEqual([]);
    expect(facts.writesText).toEqual([]);
  });
});

describe("Codex round 4 on #1199", () => {
  it("a template interpolation stays where the template puts it", () => {
    const facts = analyseModuleJs(
      `const iconName = 'icon-menu';\nicon.innerHTML = \`<svg><use href="#\${iconName}"></use></svg>\`;`,
    );
    expect(facts.rendersContent).toEqual([]);
    expect(facts.writesText).toEqual([]);
  });

  it("plain text through innerHTML is written text", () => {
    const facts = analyseModuleJs(
      "panel.innerHTML = 'Discover our latest products and explore all available services';",
    );
    expect(facts.writesText).toHaveLength(1);
  });

  it("a wrapperless parent may drive the nested module whose stamp it carries", () => {
    const child = mod(40, "Tool card", '<article class="tool-card"><h3>{{title}}</h3></article>');
    const parent = mod(
      41,
      "Tool cards",
      "{{#cards}}{{/cards}}",
      "document.querySelectorAll('.tool-card').forEach(function (c) { c.tabIndex = 0; });",
    );
    const p: StagedPage = {
      ...page(1, "/tools"),
      html: `<!doctype html><html><body><article class="tool-card" data-caelo-module-id="${child.id}"><h3>A</h3></article><script defer data-source="modules">\n${parent.js}\n</script></body></html>`,
    };
    expect(jsFindings([p], [child, parent])).toEqual([]);
  });

  it("an unused module repeating a placed module's statement is not shipped", () => {
    const form = mod(
      42,
      "Contact form",
      '<form class="contact-form"></form>',
      "document.querySelector('.contact-form');\nconsole.info('ready');",
    );
    const unused = mod(
      43,
      "Old header",
      "<header></header>",
      "document.querySelector('.contact-form');",
    );
    const p: StagedPage = {
      ...page(1, "/kontakt"),
      html: `<!doctype html><html><body>${placed(form)}<script defer data-source="modules">\n${form.js}\n</script></body></html>`,
    };
    expect(jsFindings([p], [form, unused])).toEqual([]);
  });
});

describe("foreignHooks", () => {
  it("separates one module's own hooks from hooks many modules share", () => {
    const owners = hookOwners([DEMO, HERO, TEXT]);
    const facts = analyseModuleJs(`${DEMO_JS}\n${REVEAL_JS}`);
    const r = foreignHooks(facts, new Set([id(1)]), owners);
    expect([...r.specific.keys()].sort()).toEqual([DEMO.id, HERO.id]);
    expect(r.specific.get(DEMO.id)).toEqual([".demo-form"]);
    expect(r.shared).toEqual(["[data-reveal]"]);
  });
});

describe("structure/foreign-module-js (#1198)", () => {
  it("a header carrying the demo form's script is an error naming the form modules", () => {
    const header = mod(1, "Site header", HEADER_HTML, `${MENU_JS}\n${DEMO_JS}`);
    const findings = jsFindings(
      [page(1, "/", placed(header), placed(HERO)), page(2, "/demo", placed(header), placed(DEMO))],
      [header, DEMO, HERO, TEXT],
    );
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ["structure/foreign-module-js", "error"],
    ]);
    const f = findings[0];
    expect(f?.message).toContain('"Demo form"');
    expect(f?.message).toContain('"Hero with demo form"');
    expect(f?.message).toContain(".demo-form");
    expect(f?.pageId).toBeUndefined();
    expect(() => findingSchema.parse(f)).not.toThrow();
  });

  it("the same script in the module it serves is silent", () => {
    const header = mod(1, "Site header", HEADER_HTML, MENU_JS);
    const demo = { ...DEMO, js: DEMO_JS };
    expect(
      jsFindings([page(1, "/", placed(header), placed(demo))], [header, demo, HERO, TEXT]),
    ).toEqual([]);
  });

  it("an unplaced module's script ships nowhere and is not reported", () => {
    const header = mod(1, "Site header", HEADER_HTML, DEMO_JS);
    expect(jsFindings([page(1, "/", placed(DEMO))], [header, DEMO, HERO])).toEqual([]);
  });

  it("a module may drive the modules nested inside it and the layout chrome", () => {
    const card = mod(5, "Tool card", '<article class="tool-card"><h3>{{title}}</h3></article>');
    const grid = mod(
      6,
      "Tool grid",
      '<section class="tool-grid">{{#cards}}{{/cards}}</section>',
      "document.querySelectorAll('.tool-card').forEach(function (c) { c.tabIndex = 0; });\ndocument.querySelector('.shell').dataset.ready = '1';",
    );
    const nested = `<section class="tool-grid" data-caelo-module-id="${grid.id}"><article class="tool-card" data-caelo-module-id="${card.id}"><h3>A</h3></article></section>`;
    const layout: StructureLayout = {
      id: id(50),
      displayName: "Main",
      html: '<div class="shell">{{{modules}}}</div>',
      css: "",
    };
    expect(jsFindings([page(1, "/tools", nested)], [card, grid], [layout])).toEqual([]);
  });
});

describe("structure/site-wide-module-js (#1198)", () => {
  it("a script on a hook many modules share warns until it is declared site-wide", () => {
    const header = mod(1, "Site header", HEADER_HTML, `${MENU_JS}\n${REVEAL_JS}`);
    const pages = [page(1, "/", placed(header), placed(DEMO), placed(TEXT, "x"))];
    const undeclared = jsFindings(pages, [header, DEMO, HERO, TEXT]);
    expect(undeclared.map((f) => [f.ruleId, f.severity])).toEqual([
      ["structure/site-wide-module-js", "warning"],
    ]);

    const declared = {
      ...header,
      js: `/* caelo:site-wide: scroll reveal on every section */\n${header.js}`,
    };
    expect(jsFindings(pages, [declared, DEMO, HERO, TEXT])).toEqual([]);
  });

  it("the declaration does not cover one module's own markup", () => {
    const header = mod(
      1,
      "Site header",
      HEADER_HTML,
      `/* caelo:site-wide: shared behaviour */\n${REVEAL_JS}\n${DEMO_JS}`,
    );
    const findings = jsFindings(
      [page(1, "/", placed(header), placed(DEMO))],
      [header, DEMO, HERO, TEXT],
    );
    expect(findings.map((f) => f.ruleId)).toEqual(["structure/foreign-module-js"]);
  });
});

describe("structure/js-rendered-content and js-written-text (#1198)", () => {
  it("a menu built from a JS array is an error; long written text a warning", () => {
    const header = mod(
      1,
      "Site header",
      HEADER_HTML,
      `(function () {
        var items = [
          { label: 'Gratis-Tools', href: '/tools' },
          { label: 'Preise', href: '/preise' },
          { label: 'Kontakt', href: '/kontakt' },
        ];
        var nav = document.querySelector('.site-header nav');
        items.forEach(function (i) {
          var a = document.createElement('a');
          a.href = i.href;
          a.textContent = i.label;
          nav.appendChild(a);
        });
        document.querySelector('.mega-label').textContent = 'Alle Werkzeuge für technisches SEO und Monitoring auf einen Blick';
      })();`,
    );
    const findings = jsFindings([page(1, "/", placed(header))], [header]);
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ["structure/js-rendered-content", "error"],
      ["structure/js-written-text", "warning"],
    ]);
    expect(findings[0]?.message).toContain('"Gratis-Tools"');
    for (const f of findings) expect(() => findingSchema.parse(f)).not.toThrow();
  });
});
