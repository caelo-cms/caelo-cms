// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { createSiteLinkIndex, type LinkTargetLookup } from "@caelo-cms/shared";
import { referenceFindings } from "../quality/checks/references.js";
import type { LinkTargets } from "./link-targets.js";
import { type ReferenceCheckEnv, scanReferenceIntegrity } from "./reference-integrity.js";
import type { ReferenceSourceModel, SourceModule } from "./reference-sources.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HOME = id(1);
const ABOUT = id(2);
const DRAFT = id(3);
const DE_HOME = id(4);
const GONE = id(99);
const TPL = id(10);
const LAYOUT = id(11);

const targets: LinkTargets = {
  pages: [
    { id: HOME, path: "/", status: "published", title: "Home" },
    { id: ABOUT, path: "/about", status: "published", title: "About" },
    { id: DRAFT, path: "/soon", status: "draft", title: "Soon" },
    { id: DE_HOME, path: "/de", status: "published", title: "Start" },
  ],
  media: [],
};

const lookup: LinkTargetLookup = {
  pageIdForPath: (p) => targets.pages.find((x) => x.path === p)?.id ?? null,
  mediaIdForSlug: () => null,
  pageExists: (pid) => targets.pages.some((x) => x.id === pid),
  mediaExists: () => false,
  isOwnHost: () => false,
};

function mod(n: number, html: string, fields: SourceModule["fields"] = []): SourceModule {
  return { id: id(100 + n), slug: `m-${n}`, name: `Module ${n}`, html, fields };
}

function model(over: Partial<ReferenceSourceModel> = {}): ReferenceSourceModel {
  return {
    pageTemplates: new Map([
      [HOME, TPL],
      [ABOUT, TPL],
      [DRAFT, TPL],
      [DE_HOME, TPL],
    ]),
    placements: [],
    modules: new Map(),
    instances: new Map(),
    templates: new Map([[TPL, { id: TPL, name: "Tpl", html: "<main></main>", layoutId: LAYOUT }]]),
    layouts: new Map([[LAYOUT, { id: LAYOUT, name: "Main", html: "<body></body>", blocks: [] }]]),
    sets: [],
    plugins: [],
    ...over,
  };
}

function scan(
  m: ReferenceSourceModel,
  env: ReferenceCheckEnv,
  pageVariants?: Map<string, { variant: string; group: string | null }>,
) {
  const index = createSiteLinkIndex({
    pages: targets.pages,
    media: [],
    env,
    pageUrlStyle: "directory",
    ...(pageVariants ? { pageVariants } : {}),
  });
  return scanReferenceIntegrity({ model: m, lookup, targets, index, env });
}

/** A module with a `cta` url field placed on `pageId` with `href`. */
function placed(pageId: string, href: string, n = 1): Partial<ReferenceSourceModel> {
  const m = mod(n, '<a href="{{cta}}">x</a>', [{ name: "cta", kind: "url" }]);
  const ci = id(200 + n);
  return {
    modules: new Map([[m.id, m]]),
    instances: new Map([[ci, { id: ci, moduleId: m.id, values: { cta: href } }]]),
    placements: [
      { pageId, blockName: "content", moduleId: m.id, contentInstanceId: ci, syncMode: "unsynced" },
    ],
  };
}

describe("reference integrity policy (#724 decisions)", () => {
  it("a deleted target blocks at Stage and at Publish", () => {
    for (const env of ["staging", "production"] as const) {
      const issues = scan(model(placed(ABOUT, `caelo:page/${GONE}`)), env);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ problem: "missing-target", severity: "block" });
      expect(issues[0]?.fix.tool).toBe("set_page_module_content");
      expect(issues[0]?.message).toContain('"/about"');
    }
  });

  it("an unpublished target warns at Stage and blocks at Publish", () => {
    const m = model(placed(ABOUT, `caelo:page/${DRAFT}#x`));
    expect(scan(m, "staging")[0]).toMatchObject({
      problem: "unpublished-target",
      severity: "warning",
      target: '"/soon"',
    });
    expect(scan(m, "production")[0]?.severity).toBe("block");
    expect(scan(m, "production")[0]?.fix.hint).toContain("set_pages_status_many");
  });

  it("a synced placement on one page is fixed on its content instance", () => {
    // Regression (Codex on #893): a synced row placed on a single page was
    // not "shared", so the fix named set_page_module_content — which
    // refuses synced placements.
    const synced = placed(ABOUT, `caelo:page/${GONE}`);
    const pl = synced.placements?.[0];
    if (!pl) throw new Error("placement expected");
    const issues = scan(
      model({ ...synced, placements: [{ ...pl, syncMode: "synced" }] }),
      "staging",
    );
    expect(issues[0]?.fix.tool).toBe("set_content_instance_values");
    expect(issues[0]?.fix.hint).toContain(pl.contentInstanceId ?? "");
  });

  it("a problem only on a draft page ships nowhere: a warning, never a block", () => {
    const issues = scan(model(placed(DRAFT, `caelo:page/${GONE}`)), "production");
    expect(issues[0]).toMatchObject({
      problem: "missing-target",
      severity: "warning",
      shipped: false,
    });
    // A draft page linking another draft page is no issue at all.
    expect(scan(model(placed(DRAFT, `caelo:page/${DRAFT}`)), "production")).toEqual([]);
  });

  it("nested modules are checked only where the template dispatches them", () => {
    // Regression (Codex on #893): every declared `module` / `module-list`
    // field was walked, so a nested module the HTML no longer renders
    // (`{{>field}}` / `{{#field}}` removed) blocked Stage with links that
    // never ship. The renderer is lazy; the check follows it.
    const child = mod(2, '<a href="{{cta}}">x</a>', [{ name: "cta", kind: "url" }]);
    const childCi = id(302);
    const ref = { moduleId: child.id, contentInstanceId: childCi };
    const parentWith = (html: string) => {
      const parent = mod(1, html, [
        { name: "hero", kind: "module" },
        { name: "cards", kind: "module-list" },
      ]);
      const ci = id(301);
      return model({
        modules: new Map([
          [parent.id, parent],
          [child.id, child],
        ]),
        instances: new Map([
          [ci, { id: ci, moduleId: parent.id, values: { hero: ref, cards: [ref] } }],
          [childCi, { id: childCi, moduleId: child.id, values: { cta: `caelo:page/${GONE}` } }],
        ]),
        placements: [
          {
            pageId: ABOUT,
            blockName: "c",
            moduleId: parent.id,
            contentInstanceId: ci,
            syncMode: "unsynced",
          },
        ],
      });
    };
    for (const html of ["<div>{{>hero}}</div>", "<ul>{{#cards}}<li></li>{{/cards}}</ul>"]) {
      const issues = scan(parentWith(html), "staging");
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ problem: "missing-target", severity: "block" });
      expect(issues[0]?.place).toMatchObject({ kind: "content", nested: true });
    }
    expect(scan(parentWith("<div>no nested slot</div>"), "staging")).toEqual([]);
  });

  it("a working literal path is a warning naming its conversion; a broken one is a broken-literal warning", () => {
    const ok = scan(model(placed(ABOUT, "/about#team")), "production");
    expect(ok).toEqual([
      expect.objectContaining({ problem: "literal-link", severity: "warning", target: '"/about"' }),
    ]);
    const broken = scan(model(placed(ABOUT, "/nope")), "production");
    expect(broken[0]).toMatchObject({ problem: "broken-literal", severity: "warning" });
    // A literal to a draft page follows the unpublished policy.
    expect(scan(model(placed(ABOUT, "/soon")), "production")[0]).toMatchObject({
      problem: "unpublished-target",
      severity: "block",
    });
  });

  it("text that looks like a path is not a link (#846)", () => {
    const m = mod(1, "<p>{{label}}</p>", [{ name: "label", kind: "text" }]);
    const ci = id(201);
    const issues = scan(
      model({
        modules: new Map([[m.id, m]]),
        instances: new Map([[ci, { id: ci, moduleId: m.id, values: { label: "/nope" } }]]),
        placements: [
          {
            pageId: ABOUT,
            blockName: "content",
            moduleId: m.id,
            contentInstanceId: ci,
            syncMode: "unsynced",
          },
        ],
      }),
      "production",
    );
    expect(issues).toEqual([]);
  });

  it("a link without a same-language page is variant-missing on the rendering page only", () => {
    const m = model({
      ...placed(DE_HOME, `caelo:page/${ABOUT}`),
    });
    const variants = new Map([
      [HOME, { variant: "en", group: "home" }],
      [DE_HOME, { variant: "de", group: "home" }],
      [ABOUT, { variant: "en", group: "about" }],
    ]);
    const issues = scan(m, "staging", variants);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      problem: "variant-missing",
      variant: "de",
      severity: "block",
    });
    expect(issues[0]?.pageIds).toEqual([DE_HOME]);
    expect(issues[0]?.fix.hint).toContain("create_variant");
  });
});

describe("reference integrity places", () => {
  it("module HTML shared by several pages is one issue listing its pages, fixed once with edit_content", () => {
    const m = mod(1, `<a href="caelo:page/${GONE}">x</a>`);
    const issues = scan(
      model({
        modules: new Map([[m.id, m]]),
        placements: [HOME, ABOUT].map((pageId) => ({
          pageId,
          blockName: "content",
          moduleId: m.id,
          contentInstanceId: null,
          syncMode: null,
        })),
      }),
      "staging",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.place.kind).toBe("module-html");
    expect(issues[0]?.pageIds).toEqual([HOME, ABOUT].sort());
    expect(issues[0]?.fix.tool).toBe("edit_content");
  });

  it("layout chrome renders its field defaults on every page of the layout", () => {
    const header = mod(2, "<nav></nav>", [
      { name: "links", kind: "link-list", default: [{ label: "x", href: `caelo:page/${GONE}` }] },
    ]);
    const issues = scan(
      model({
        modules: new Map([[header.id, header]]),
        layouts: new Map([
          [
            LAYOUT,
            {
              id: LAYOUT,
              name: "Main",
              html: `<body><a href="caelo:page/${GONE}">x</a></body>`,
              blocks: [{ blockName: "header", moduleIds: [header.id] }],
            },
          ],
        ]),
      }),
      "staging",
    );
    const kinds = issues.map((i) => i.place.kind).sort();
    expect(kinds).toEqual(["layout-html", "module-default"]);
    expect(issues.every((i) => i.severity === "block")).toBe(true);
    expect(issues.find((i) => i.place.kind === "layout-html")?.fix.tool).toBe(
      "propose_update_layout",
    );
  });

  it("a nav set renders where its nav-menu module does; an unrendered set only warns", () => {
    const nav = { ...mod(3, "<nav></nav>"), slug: "nav-menu-main" };
    const set = (slug: string) => ({
      id: id(300),
      kind: "nav-menu",
      slug,
      name: "Main",
      items: [{ label: "x", href: `caelo:page/${GONE}` }],
    });
    const rendered = scan(
      model({
        modules: new Map([[nav.id, nav]]),
        placements: [
          {
            pageId: HOME,
            blockName: "c",
            moduleId: nav.id,
            contentInstanceId: null,
            syncMode: null,
          },
        ],
        sets: [set("main")],
      }),
      "staging",
    );
    expect(rendered[0]).toMatchObject({ severity: "block", where: "items[0]" });
    expect(rendered[0]?.fix.tool).toBe("set_structured_set");
    const unrendered = scan(model({ sets: [set("other")] }), "staging");
    expect(unrendered[0]?.severity).toBe("warning");
  });

  it("plugin data is site-wide and names the plugin", () => {
    const issues = scan(
      model({
        plugins: [
          {
            pluginSlug: "international-site",
            label: "German footer",
            value: { links: [{ href: `caelo:page/${GONE}` }] },
            fields: null,
          },
        ],
      }),
      "production",
    );
    expect(issues[0]).toMatchObject({ problem: "missing-target", severity: "block", pageIds: [] });
    expect(issues[0]?.message).toContain('plugin "international-site": German footer');
  });
});

describe("references quality check findings", () => {
  it("maps blocks to errors, keeps page-bound content on its page and leaves broken literals to the links check", () => {
    const content = scan(model(placed(ABOUT, `caelo:page/${DRAFT}`)), "production");
    const broken = scan(model(placed(HOME, "/nope", 2)), "production");
    const findings = referenceFindings([...content, ...broken], true, new Set([HOME, ABOUT]));
    expect(findings.map((f) => [f.ruleId, f.severity, f.pageId])).toEqual([
      ["references/unpublished-target", "error", ABOUT],
      ["references/limit-reached", "info", undefined],
    ]);
  });

  it("an issue stored on a draft page stays site-scoped: the staged build has no such page", () => {
    // Regression (Codex on #893): naming a page outside the staged build made
    // the runner reject the whole `references` check, failing the audit
    // instead of reporting a non-blocking warning.
    const issues = scan(model(placed(DRAFT, `caelo:page/${GONE}`)), "production");
    expect(issues[0]?.pageIds).toEqual([DRAFT]);
    const findings = referenceFindings(issues, false, new Set([HOME, ABOUT, DE_HOME]));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "references/missing-target", severity: "warning" });
    expect(findings[0]?.pageId).toBeUndefined();
    expect(findings[0]?.message).toContain('"/soon"');
  });
});
