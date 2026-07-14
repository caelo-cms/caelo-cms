// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the DIRECT-BUILD unit-collection fallback in
 * `imports.migrate_media` (issue #278 keystone fix).
 *
 * The #278 homepage-first flow builds pages straight through `pages.create`
 * (no `import_pages.accepted_page_id`) and binds chrome via `layout_modules`
 * — so the op's compose-keyed queries return nothing and NO media (the
 * header logo included) ever migrated. `assembleDirectBuildUnits` is the
 * pure core of the fallback: given the rows the handler collects from the
 * live migration-built site, it must produce the rewritable text units —
 * crucially including the layout-bound header where the logo lives.
 *
 * Pure function → no Postgres, runs under `bun test`.
 */

import { describe, expect, it } from "bun:test";
import type { ModuleTextWithProvenance } from "../media/direct-build-units.js";
import type { ModuleState, PageLayoutState } from "../snapshots/state.js";
import {
  assembleDirectBuildUnits,
  resolveDirectBuildModuleRows,
  type TextUnit,
} from "./import_media.js";

const SOURCE = "https://searchviu.com/";
const BRANCH = "11111111-1111-4111-8111-111111111111";

describe("assembleDirectBuildUnits (direct-build media fallback)", () => {
  it("collects the layout-bound header (logo) module the compose path misses", () => {
    const units = assembleDirectBuildUnits(
      {
        pageModules: [
          { id: "page-hero", html: '<section class="hero"><h1>Home</h1></section>', css: "" },
        ],
        chromeModules: [
          {
            id: "site-header",
            html: '<header><img class="logo" src="https://searchviu.com/logo2x.png"></header>',
            css: "",
          },
          { id: "site-footer", html: "<footer>© SearchVIU</footer>", css: "" },
        ],
        templates: [{ id: "tmpl-home", css: ".hero{background:url(/bg.png)}" }],
      },
      SOURCE,
    );

    // The header module (where the logo <img> lives) is present as a unit.
    const header = units.find((u) => u.id === "site-header");
    expect(header).toBeDefined();
    expect(header?.kind).toBe("module");
    expect(header?.html).toContain("logo2x.png");
    // Every fallback unit resolves relative refs against the run origin.
    expect(units.every((u) => u.baseUrl === SOURCE)).toBe(true);
  });

  it("emits module + template units with the right kinds and bases", () => {
    const units = assembleDirectBuildUnits(
      {
        pageModules: [{ id: "m1", html: "<p>a</p>", css: ".a{}" }],
        chromeModules: [{ id: "h1", html: "<header>x</header>", css: "" }],
        templates: [{ id: "t1", css: ".t{}" }],
      },
      SOURCE,
    );

    const modules = units.filter((u) => u.kind === "module");
    const templates = units.filter((u) => u.kind === "template");
    expect(modules.map((u) => u.id).sort()).toEqual(["h1", "m1"]);
    expect(templates).toHaveLength(1);
    // Template units are css-only (empty html) per the TextUnit contract.
    expect(templates[0]?.html).toBe("");
    expect(templates[0]?.css).toBe(".t{}");
  });

  it("dedupes a module by id — page-module row wins over the chrome copy", () => {
    const units = assembleDirectBuildUnits(
      {
        pageModules: [{ id: "dup", html: "<p>page copy</p>", css: "" }],
        chromeModules: [{ id: "dup", html: "<header>chrome copy</header>", css: "" }],
        templates: [],
      },
      SOURCE,
    );

    const matches = units.filter((u) => u.id === "dup");
    expect(matches).toHaveLength(1);
    // Page modules are inserted first, so the page row wins the dedup.
    expect(matches[0]?.html).toBe("<p>page copy</p>");
  });

  it("returns an empty array when the built site has no rewritable text", () => {
    const units: TextUnit[] = assembleDirectBuildUnits(
      { pageModules: [], chromeModules: [], templates: [] },
      SOURCE,
    );
    expect(units).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// issue #302 — branch-aware placement→text resolution. The fixture mirrors
// the REAL run-15 shape: a chat-run #278 migration where
//   - pages were created via create_page + add_module_to_page INSIDE a chat,
//     so `pages.set_modules` skipped the live `page_modules` write and the
//     placements exist ONLY as branched page_layout_snapshots,
//   - chrome was bound via add_module_to_layout (layout_modules rows ARE
//     live even when branched),
//   - module text lives in branched module_snapshots (branched creates/edits
//     never update the live row after creation).
// The pre-#302 fallback joined live page_modules and found ZERO units here
// (media_assets n_tup_ins=0 for the whole run).
// ---------------------------------------------------------------------------

function moduleState(id: string, html: string, css = ""): ModuleState {
  return {
    schemaVersion: 1,
    slug: id,
    displayName: id,
    type: id,
    html,
    css,
    js: "",
    fields: [],
    deletedAt: null,
  };
}

function provenance(
  state: ModuleState,
  opts: { fromBranchSnapshot: boolean; liveChatBranchId: string | null },
): ModuleTextWithProvenance {
  return { state, ...opts };
}

/** Placements as `pages.set_modules` (branched) snapshots them — v0.12 shape. */
function layoutState(blocks: Array<{ blockName: string; moduleIds: string[] }>): PageLayoutState {
  return {
    schemaVersion: 1,
    blocks: blocks.map((b) => ({
      blockName: b.blockName,
      moduleIds: b.moduleIds,
      placements: b.moduleIds.map((moduleId) => ({
        moduleId,
        contentInstanceId: `ci-${moduleId}`,
        syncMode: "unsynced" as const,
      })),
    })),
  };
}

describe("resolveDirectBuildModuleRows (issue #302 branch-overlay fallback)", () => {
  it("REGRESSION run #15: finds page modules when live page_modules is EMPTY and placements exist only as branch snapshots", () => {
    // Two chat-built pages; placements come from branched
    // page_layout_snapshots (live page_modules has zero rows — the
    // handler never even queries it anymore; the overlay loader returns
    // these states).
    const rows = resolveDirectBuildModuleRows({
      layoutStatesByPage: [
        {
          pageId: "page-home",
          state: layoutState([{ blockName: "content", moduleIds: ["hero", "features"] }]),
        },
        {
          pageId: "page-pricing",
          state: layoutState([{ blockName: "content", moduleIds: ["pricing-table"] }]),
        },
      ],
      chromeModuleIds: [],
      moduleTextById: new Map([
        [
          "hero",
          provenance(
            moduleState("hero", '<section><img src="https://searchviu.com/hero.jpg"></section>'),
            { fromBranchSnapshot: true, liveChatBranchId: BRANCH },
          ),
        ],
        [
          "features",
          provenance(moduleState("features", "<ul><li>a</li></ul>"), {
            fromBranchSnapshot: true,
            liveChatBranchId: BRANCH,
          }),
        ],
        [
          "pricing-table",
          provenance(moduleState("pricing-table", "<table></table>"), {
            fromBranchSnapshot: true,
            liveChatBranchId: BRANCH,
          }),
        ],
      ]),
    });

    expect(rows.pageModules.map((r) => r.id).sort()).toEqual(["features", "hero", "pricing-table"]);
    expect(rows.missingModuleIds).toEqual([]);
    // The hero's hotlinked image is visible to the rewriter.
    expect(rows.pageModules.find((r) => r.id === "hero")?.html).toContain("hero.jpg");
    // Provenance travels with the row so the rewrite step can emit the
    // branched snapshot that survives chat.publish.
    const hero = rows.pageModules.find((r) => r.id === "hero");
    expect(hero?.fromBranchSnapshot).toBe(true);
    expect(hero?.liveChatBranchId).toBe(BRANCH);
  });

  it("resolves layout-bound chrome (add_module_to_layout) — where the logo lives", () => {
    const rows = resolveDirectBuildModuleRows({
      layoutStatesByPage: [],
      chromeModuleIds: ["site-header", "site-footer"],
      moduleTextById: new Map([
        [
          "site-header",
          provenance(
            moduleState(
              "site-header",
              '<header><img class="logo" src="https://searchviu.com/logo2x.png"></header>',
            ),
            { fromBranchSnapshot: false, liveChatBranchId: BRANCH },
          ),
        ],
        [
          "site-footer",
          provenance(moduleState("site-footer", "<footer>c</footer>"), {
            fromBranchSnapshot: false,
            liveChatBranchId: BRANCH,
          }),
        ],
      ]),
    });
    expect(rows.chromeModules.map((r) => r.id)).toEqual(["site-header", "site-footer"]);
    expect(rows.chromeModules[0]?.html).toContain("logo2x.png");
    expect(rows.missingModuleIds).toEqual([]);
  });

  it("falls back to pre-v0.12 moduleIds when a snapshot has no placements", () => {
    const legacyState: PageLayoutState = {
      schemaVersion: 1,
      blocks: [{ blockName: "content", moduleIds: ["legacy-mod"] }],
    };
    const rows = resolveDirectBuildModuleRows({
      layoutStatesByPage: [{ pageId: "p1", state: legacyState }],
      chromeModuleIds: [],
      moduleTextById: new Map([
        [
          "legacy-mod",
          provenance(moduleState("legacy-mod", "<p>x</p>"), {
            fromBranchSnapshot: true,
            liveChatBranchId: null,
          }),
        ],
      ]),
    });
    expect(rows.pageModules.map((r) => r.id)).toEqual(["legacy-mod"]);
  });

  it("dedupes a module placed on several pages and reports unresolvable ids loudly", () => {
    const rows = resolveDirectBuildModuleRows({
      layoutStatesByPage: [
        {
          pageId: "p1",
          state: layoutState([{ blockName: "content", moduleIds: ["shared", "ghost"] }]),
        },
        { pageId: "p2", state: layoutState([{ blockName: "content", moduleIds: ["shared"] }]) },
      ],
      chromeModuleIds: ["ghost"],
      moduleTextById: new Map([
        [
          "shared",
          provenance(moduleState("shared", "<p>s</p>"), {
            fromBranchSnapshot: true,
            liveChatBranchId: BRANCH,
          }),
        ],
      ]),
    });
    expect(rows.pageModules.map((r) => r.id)).toEqual(["shared"]);
    expect(rows.chromeModules).toEqual([]);
    expect(rows.missingModuleIds).toEqual(["ghost"]);
  });

  it("feeds assembleDirectBuildUnits end-to-end: branch-built pages + chrome + template css all become units", () => {
    const resolved = resolveDirectBuildModuleRows({
      layoutStatesByPage: [
        { pageId: "home", state: layoutState([{ blockName: "content", moduleIds: ["hero"] }]) },
      ],
      chromeModuleIds: ["site-header"],
      moduleTextById: new Map([
        [
          "hero",
          provenance(moduleState("hero", '<img src="https://searchviu.com/hero.jpg">'), {
            fromBranchSnapshot: true,
            liveChatBranchId: BRANCH,
          }),
        ],
        [
          "site-header",
          provenance(moduleState("site-header", '<img src="https://searchviu.com/logo.png">'), {
            fromBranchSnapshot: false,
            liveChatBranchId: BRANCH,
          }),
        ],
      ]),
    });
    const units = assembleDirectBuildUnits(
      {
        pageModules: resolved.pageModules,
        chromeModules: resolved.chromeModules,
        templates: [{ id: "tmpl-home", css: ".hero{background:url(/bg.png)}" }],
      },
      SOURCE,
    );
    expect(units.map((u) => u.id).sort()).toEqual(["hero", "site-header", "tmpl-home"]);
    // Module units carry the full state so the handler can emit a branched
    // snapshot with the rewritten html (the publish-clobber fix).
    const heroUnit = units.find((u) => u.id === "hero");
    expect(heroUnit?.moduleState?.html).toContain("hero.jpg");
    expect(heroUnit?.fromBranchSnapshot).toBe(true);
  });
});
