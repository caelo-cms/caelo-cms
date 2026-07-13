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
import { assembleDirectBuildUnits, type TextUnit } from "./import_media.js";

const SOURCE = "https://searchviu.com/";

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
