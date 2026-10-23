// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #820 — the core structure check. The fixture models the dogfood
 * site that produced the issue: a step chain pasted into a generic text
 * module's field on several pages, a diff card that exists as a module AND
 * as a free copy, a copied module, and pattern CSS in the layout.
 */

import { describe, expect, it } from "bun:test";
import {
  type NestedModuleResource,
  type NestedRenderResolver,
  renderPlacedModule,
  tagModuleId,
} from "@caelo-cms/shared";
import type { StagedPage } from "../check.js";
import { findingSchema } from "../findings.js";
import { runFindingChecks } from "../runner.js";
import { createStructureCheck, type StructureLayout, structureFindings } from "../structure.js";
import { type StructureModule, selectorClasses } from "../structure-analysis.js";
import { NO_PROBE_BUILD } from "./fixtures/test-checks.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const TEXT: StructureModule = {
  id: id(101),
  slug: "text",
  displayName: "Text",
  html: '<section class="prose"><h2>{{title}}</h2><div class="body">{{body}}</div></section>',
};
const DIFF_TEMPLATE =
  '<div class="split"><div class="copy"><h2>{{title}}</h2><p>{{lead}}</p></div>' +
  '<div class="diff-card"><div class="diff-head"><span class="dot"></span></div><pre class="diff-body">{{code}}</pre></div></div>';
const DIFF: StructureModule = {
  id: id(102),
  slug: "split-diff",
  displayName: "Split with diff",
  html: DIFF_TEMPLATE,
};
const DIFF_COPY: StructureModule = {
  id: id(103),
  slug: "split-diff-2",
  displayName: "Split with diff (pricing)",
  html: DIFF_TEMPLATE.replace("{{title}}", "Pricing"),
};
const NAV: StructureModule = {
  id: id(104),
  slug: "nav-menu-main",
  displayName: "Main menu",
  html: '<nav class="menu"><ul><li><a class="item">{{label}}</a></li></ul></nav>',
};
const MODULES = [TEXT, DIFF, DIFF_COPY, NAV];

const chain = (steps: number, extra = "") =>
  `<div class="chain">${Array.from(
    { length: steps },
    (_, i) => `<div class="step"><span class="n">${i + 1}</span><p>Step ${i}</p>${extra}</div>`,
  ).join('<span class="arrow"></span>')}</div>`;

const diffMarkup = (title: string) =>
  DIFF_TEMPLATE.replace("{{title}}", title).replace("{{lead}}", "x").replace("{{code}}", "+a");

function text(body: string, title = "T"): string {
  return `<section class="prose" data-caelo-module-id="${TEXT.id}"><h2>${title}</h2><div class="body">${body}</div></section>`;
}

function placed(m: StructureModule, html: string): string {
  return html.replace(/^<(\w+)/, `<$1 data-caelo-module-id="${m.id}"`);
}

function page(n: number, path: string, ...modules: string[]): StagedPage {
  return {
    pageId: id(n),
    path,
    url: `http://s.test${path}`,
    html: `<!doctype html><html><head><style>x</style></head><body><header class="site-header"><a class="logo">L</a></header><main>${modules.join("")}</main></body></html>`,
  };
}

const noLayouts: StructureLayout[] = [];

describe("structure/repeated-markup", () => {
  it("a pattern pasted into field values on two pages is an error on both", () => {
    const findings = structureFindings(
      [
        page(1, "/a", text(`<p>intro</p>${chain(3)}`)),
        page(2, "/b", text(chain(5))),
        page(3, "/c", text("<p>only prose</p>")),
      ],
      MODULES,
      noLayouts,
    );
    const repeated = findings.filter((f) => f.ruleId === "structure/repeated-markup");
    expect(repeated.map((f) => [f.pageId, f.severity])).toEqual([
      [id(1), "error"],
      [id(2), "error"],
    ]);
    expect(repeated[0]?.message).toStartWith("Repeated free markup: `div.chain`");
    expect(repeated[0]?.message).toContain('in "Text"');
    expect(repeated[0]?.message).toContain("/a, /b");
    expect(repeated[0]?.fix?.tool).toBe("add_module");
    for (const f of findings) expect(findingSchema.safeParse(f).success).toBe(true);
  });

  it("one-off free markup on a single page is allowed", () => {
    expect(structureFindings([page(1, "/a", text(chain(3)))], MODULES, noLayouts)).toEqual([]);
  });

  it("the same pattern rendered by one module on many pages is the reuse we want", () => {
    const findings = structureFindings(
      [1, 2, 3].map((n) => page(n, `/p${n}`, placed(DIFF, diffMarkup(`Title ${n}`)))),
      [TEXT, DIFF],
      noLayouts,
    );
    expect(findings).toEqual([]);
  });

  it("a free copy of an existing module's markup is an error even on one page", () => {
    const findings = structureFindings(
      [page(1, "/a", text(diffMarkup("Copied")))],
      [TEXT, DIFF],
      noLayouts,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "structure/repeated-markup", severity: "error" });
    expect(findings[0]?.message).toContain(`module "Split with diff" (${DIFF.id})`);
    expect(findings[0]?.fix?.hint).toStartWith("place the existing module by moduleId");
  });

  it("a navigation menu (rendered from its set, not its template) is never attributed", () => {
    const nav = `<nav data-caelo-module-id="${NAV.id}"><ul><li><a href="/">Home</a></li></ul></nav>`;
    expect(structureFindings([page(1, "/a", nav), page(2, "/b", nav)], MODULES, noLayouts)).toEqual(
      [],
    );
  });
});

describe("#1027 — nested modules are module output, not free markup", () => {
  // The searchVIU cases: FAQ items (`module-list` of "FAQ-Eintrag") on 24
  // pages and tool cards (`module-list` "karten" of "Tool-Karte") on 9.
  // Rendered through the real nested renderer and the composer's root
  // tag, so the test fails if either stops stamping module roots.
  const FAQ_ENTRY: NestedModuleResource = {
    moduleId: id(201),
    slug: "faq-entry",
    html: "<details><summary>{{question}}</summary><p>{{answer}}</p></details>",
    css: "",
    js: "",
    fields: [
      { name: "question", kind: "text" },
      { name: "answer", kind: "text" },
    ],
  };
  const FAQ = {
    id: id(202),
    slug: "faq",
    displayName: "FAQ",
    html: '<section class="faq-wrap"><h2>{{title}}</h2><div class="faq">{{#items}}{{/items}}</div>{{>featured}}</section>',
    fields: [
      { name: "title", kind: "text" as const },
      { name: "items", kind: "module-list" as const },
      { name: "featured", kind: "module" as const },
    ],
  };
  const TOOL_CARD: NestedModuleResource = {
    moduleId: id(203),
    slug: "tool-card",
    html:
      '<article class="tc" id="{{anchor}}"><div class="tc-head"><span class="ico"></span><h3>{{title}}</h3></div>' +
      '<p>{{text}}</p><ul class="tc-pts">{{#points}}<li>{{.}}</li>{{/points}}</ul><a class="more" href="{{href}}">Mehr</a></article>',
    css: "",
    js: "",
    fields: [
      { name: "anchor", kind: "text" },
      { name: "title", kind: "text" },
      { name: "text", kind: "text" },
      { name: "points", kind: "text-list" },
      { name: "href", kind: "text" },
    ],
  };
  const TOOL_LIST = {
    id: id(204),
    slug: "tool-card-list",
    displayName: "Tool-Karten-Liste",
    html: '<section class="tcl"><h2>{{title}}</h2><div class="tcg">{{#karten}}{{/karten}}</div></section>',
    fields: [
      { name: "title", kind: "text" as const },
      { name: "karten", kind: "module-list" as const },
    ],
  };
  const asStructure = (m: NestedModuleResource): StructureModule => ({
    id: m.moduleId,
    slug: m.slug,
    displayName: m.slug,
    html: m.html,
  });
  const nestedModules = [asStructure(FAQ_ENTRY), asStructure(TOOL_CARD)];

  /** One instance per (page, item), so every page has its own copy. */
  function resolverFor(pages: number): NestedRenderResolver {
    const instances = new Map<string, { moduleId: string; values: Record<string, unknown> }>();
    for (let p = 1; p <= pages; p++) {
      for (let i = 0; i < 3; i++) {
        instances.set(`faq-${p}-${i}`, {
          moduleId: FAQ_ENTRY.moduleId,
          values: { question: `Q${p}.${i}?`, answer: `A${p}.${i}` },
        });
        instances.set(`card-${p}-${i}`, {
          moduleId: TOOL_CARD.moduleId,
          values: {
            anchor: `t${i}`,
            title: `Tool ${i}`,
            text: "x",
            points: ["a", "b"],
            href: "/t",
          },
        });
      }
    }
    return {
      getModule: (mid) => [FAQ_ENTRY, TOOL_CARD].find((m) => m.moduleId === mid) ?? null,
      getContentInstance: (cid) => {
        const ci = instances.get(cid);
        return ci ? { id: cid, ...ci, deletedAt: null } : null;
      },
    };
  }

  function renderPage(n: number, resolver: NestedRenderResolver): StagedPage {
    const ref = (kind: string, moduleId: string, i: number) => ({
      moduleId,
      contentInstanceId: `${kind}-${n}-${i}`,
    });
    const faq = renderPlacedModule(
      {
        html: FAQ.html,
        fields: FAQ.fields,
        values: {
          title: "FAQ",
          items: [0, 1, 2].map((i) => ref("faq", FAQ_ENTRY.moduleId, i)),
          featured: ref("faq", FAQ_ENTRY.moduleId, 0),
        },
      },
      resolver,
      {},
    );
    const tools = renderPlacedModule(
      {
        html: TOOL_LIST.html,
        fields: TOOL_LIST.fields,
        values: {
          title: "Tools",
          karten: [0, 1, 2].map((i) => ref("card", TOOL_CARD.moduleId, i)),
        },
      },
      resolver,
      {},
    );
    expect([...faq.failures, ...tools.failures]).toEqual([]);
    return page(n, `/p${n}`, tagModuleId(faq.html, FAQ.id), tagModuleId(tools.html, TOOL_LIST.id));
  }

  it("module and module-list sub-modules on many pages produce no findings", () => {
    const resolver = resolverFor(4);
    const pages = [1, 2, 3, 4].map((n) => renderPage(n, resolver));
    expect(pages[0]?.html).toContain(`<details data-caelo-module-id="${FAQ_ENTRY.moduleId}">`);
    expect(pages[0]?.html).toContain(
      `<article class="tc" id="t0" data-caelo-module-id="${TOOL_CARD.moduleId}">`,
    );
    const findings = structureFindings(
      pages,
      [...MODULES, FAQ, TOOL_LIST, ...nestedModules],
      noLayouts,
    );
    expect(findings).toEqual([]);
  });

  it("markup pasted into a richtext value next to nested modules is still an error (#820)", () => {
    const resolver = resolverFor(2);
    const pages = [1, 2].map((n) => {
      const p = renderPage(n, resolver);
      return { ...p, html: p.html.replace("<main>", `<main>${text(chain(3))}`) };
    });
    const findings = structureFindings(
      pages,
      [...MODULES, FAQ, TOOL_LIST, ...nestedModules],
      noLayouts,
    );
    expect(findings.map((f) => [f.ruleId, f.pageId])).toEqual([
      ["structure/repeated-markup", id(1)],
      ["structure/repeated-markup", id(2)],
    ]);
    expect(findings[0]?.message).toStartWith("Repeated free markup: `div.chain`");
  });
});

describe("structure/similar-markup", () => {
  it("a near match across pages is a warning, not an error", () => {
    const findings = structureFindings(
      [page(1, "/a", text(chain(3))), page(2, "/b", text(chain(3, "<small>note</small>")))],
      MODULES,
      noLayouts,
    );
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ["structure/similar-markup", "warning"],
      ["structure/similar-markup", "warning"],
    ]);
    expect(findings[0]?.message).toStartWith("Similar free markup:");
  });
});

describe("structure/duplicate-module", () => {
  it("two placed modules with the same template structure are an error where placed", () => {
    const findings = structureFindings(
      [
        page(1, "/a", placed(DIFF, diffMarkup("A"))),
        page(2, "/pricing", placed(DIFF_COPY, diffMarkup("Pricing"))),
      ],
      MODULES,
      noLayouts,
    );
    expect(findings.map((f) => [f.ruleId, f.pageId])).toEqual([
      ["structure/duplicate-module", id(1)],
      ["structure/duplicate-module", id(2)],
    ]);
    expect(findings[0]?.message).toContain('"Split with diff (pricing)"');
  });

  it("an unplaced copy is not reported (nothing on the staged build uses it)", () => {
    const findings = structureFindings(
      [page(1, "/a", placed(DIFF, diffMarkup("A")))],
      MODULES,
      noLayouts,
    );
    expect(findings).toEqual([]);
  });
});

describe("structure/layout-css-module-specific", () => {
  const layout: StructureLayout = {
    id: id(201),
    displayName: "Site",
    html: '<div class="shell">{{>header}}{{>main}}</div>',
    css:
      "/* .commented {} */ .shell{display:grid} .site-header{padding:1rem}" +
      " .chain{display:flex} @media (min-width: 40.5em){ .step{flex:1} }" +
      " .diff-card{border:1px solid} .prose h2{margin:0} .unused{x:y}",
  };

  it("flags layout rules for one module's classes or free-markup classes only", () => {
    const findings = structureFindings(
      [
        page(1, "/a", text(chain(3)), placed(DIFF, diffMarkup("A"))),
        page(2, "/b", text("<p>x</p>")),
      ],
      [TEXT, DIFF],
      [layout],
    );
    const css = findings.filter((f) => f.ruleId === "structure/layout-css-module-specific");
    expect(css).toHaveLength(1);
    expect(css[0]?.severity).toBe("warning");
    expect(css[0]?.pageId).toBeUndefined();
    const msg = css[0]?.message ?? "";
    expect(msg).toContain(".chain (free markup only)");
    expect(msg).toContain(".step (free markup only)");
    expect(msg).toContain('.diff-card (module "Split with diff")');
    expect(msg).toContain('.prose (module "Text")');
    // Layout chrome, the layout's own markup and unused classes are not module CSS.
    for (const cls of [".site-header", ".shell", ".unused", ".commented"]) {
      expect(msg).not.toContain(`${cls} (`);
    }
  });

  it("selectorClasses reads selectors and at-rule bodies, never declarations or urls", () => {
    expect([
      ...selectorClasses(
        ".a,.b>.c{margin:1.5rem;background:url(x.png)} @media (min-width:40.5em){.d{x:y}} [data-x='.e']{}",
      ),
    ]).toEqual(["a", "b", "c", "d"]);
  });
});

describe("createStructureCheck", () => {
  it("runs through the runner as a valid site check", async () => {
    const check = createStructureCheck({
      modules: async () => MODULES,
      layouts: async () => [],
    });
    const result = await runFindingChecks(
      [
        {
          kind: "findings",
          id: check.id,
          title: check.title,
          scope: "site",
          source: { kind: "core" },
          check,
        },
      ],
      [page(1, "/a", text(chain(2))), page(2, "/b", text(chain(4)))],
      NO_PROBE_BUILD,
    );
    expect(result.errors).toEqual([]);
    expect(result.findings).toHaveLength(2);
  });

  it("a failed source read fails the check loudly instead of reporting nothing", async () => {
    const check = createStructureCheck({
      modules: async () => {
        throw new Error("modules.list failed: boom");
      },
      layouts: async () => [],
    });
    const result = await runFindingChecks(
      [
        {
          kind: "findings",
          id: check.id,
          title: check.title,
          scope: "site",
          source: { kind: "core" },
          check,
        },
      ],
      [page(1, "/a", text("<p>x</p>"))],
      NO_PROBE_BUILD,
    );
    expect(result.findings).toEqual([]);
    expect(result.errors[0]?.message).toContain("modules.list failed: boom");
  });
});
