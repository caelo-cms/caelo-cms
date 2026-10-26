// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import {
  allSettingsLinks,
  filterSettingsGroups,
  hasAnySettingsAccess,
  SETTINGS_GROUPS,
  SETTINGS_SUB_PAGES,
  settingsCrumbLabel,
  visibleSettingsGroups,
} from "./settings-nav.js";

const AUTHED_ROUTES = join(import.meta.dir, "..", "routes", "(authed)");

/** Every page route id under /settings, e.g. `/settings/layouts/[id]`. */
function settingsPageRoutes(): string[] {
  const glob = new Glob("settings/**/+page.svelte");
  return [...glob.scanSync({ cwd: AUTHED_ROUTES })]
    .map((f) => `/${f.replace(/\/?\+page\.svelte$/, "")}`)
    .sort();
}

/** The first permission the page's `load` requires — what a visitor without it hits as 403. */
function loadPermission(route: string): string | null {
  const src = readFileSync(join(AUTHED_ROUTES, route, "+page.server.ts"), "utf8");
  const load = src.slice(src.indexOf("export const load"));
  return /requirePermission\(\s*locals,\s*"([a-z._]+)"/.exec(load)?.[1] ?? null;
}

describe("settings nav model", () => {
  const links = allSettingsLinks();
  const linked = new Set(links.map((l) => l.href));
  const subPages = new Set(SETTINGS_SUB_PAGES.map((s) => s.route));

  it("reaches every page under /settings (issue #684: pages were unlinked)", () => {
    const unreachable = settingsPageRoutes().filter(
      (r) => r !== "/settings" && !linked.has(r) && !subPages.has(r),
    );
    expect(unreachable).toEqual([]);
  });

  it("links only to pages that exist", () => {
    const routes = new Set(settingsPageRoutes());
    const dangling = [...linked, ...subPages].filter((h) => !routes.has(h));
    expect(dangling).toEqual([]);
  });

  it("lists each page once", () => {
    const hrefs = [...links.map((l) => l.href), ...subPages];
    expect(hrefs.length).toBe(new Set(hrefs).size);
  });

  it("names a sub-page's parent that the overview links", () => {
    for (const s of SETTINGS_SUB_PAGES) {
      expect(s.parent === "/settings" || linked.has(s.parent)).toBe(true);
    }
  });

  it("gates every link with the permission its page's load requires", () => {
    const mismatched = [...links, ...SETTINGS_SUB_PAGES.map((s) => ({ ...s, href: s.route }))]
      .map((l) => ({ href: l.href, model: l.permission, page: loadPermission(l.href) }))
      .filter((m) => m.model !== m.page);
    expect(mismatched).toEqual([]);
  });

  it("gives every row a one-line description", () => {
    for (const l of links) {
      expect(l.description.length).toBeGreaterThan(10);
      expect(l.description).not.toContain("\n");
    }
  });
});

describe("visibleSettingsGroups", () => {
  it("shows every group to an Owner", () => {
    const owner = new Set(allSettingsLinks().map((l) => l.permission));
    expect(visibleSettingsGroups(owner).map((g) => g.id)).toEqual(SETTINGS_GROUPS.map((g) => g.id));
  });

  it("hides rows and related links the role cannot open, and empty groups", () => {
    const groups = visibleSettingsGroups(["content.read"]);
    expect(groups.map((g) => g.id)).toEqual(["site"]);
    expect(groups[0]?.entries.map((e) => e.href)).toEqual(["/settings/redirects"]);
  });

  it("drops related links above the viewer's permission", () => {
    const groups = visibleSettingsGroups(["ops.view"]);
    const deployments = groups
      .flatMap((g) => g.entries)
      .find((e) => e.href === "/settings/deployments");
    expect(deployments?.related).toEqual([]);
  });

  // Regression (codex review on #688): a related page is gated by its own
  // permission, so it must not vanish with an inaccessible parent.
  it("promotes related pages the viewer may open when their parent is hidden", () => {
    const hrefs = visibleSettingsGroups(["content.read", "content.write"]).flatMap((g) =>
      g.entries.map((e) => e.href),
    );
    expect(hrefs).toEqual([
      "/settings/redirects",
      "/settings/quality/pending",
      "/settings/templates/pending",
    ]);
    expect(hasAnySettingsAccess(["deploy.trigger"])).toBe(true);
  });

  it("every page in the model is reachable by a role holding only its permission", () => {
    for (const link of allSettingsLinks()) {
      const hrefs = visibleSettingsGroups([link.permission]).flatMap((g) =>
        g.entries.flatMap((e) => [e.href, ...(e.related ?? []).map((r) => r.href)]),
      );
      expect(hrefs).toContain(link.href);
    }
  });

  it("reports no access for a role without any Settings permission", () => {
    expect(hasAnySettingsAccess([])).toBe(false);
    expect(hasAnySettingsAccess(new Set(["settings.read"]))).toBe(true);
  });
});

describe("filterSettingsGroups", () => {
  const all = [...SETTINGS_GROUPS];

  it("finds the staging host by an operator's words", () => {
    const hrefs = filterSettingsGroups(all, "staging host").flatMap((g) =>
      g.entries.map((e) => e.href),
    );
    expect(hrefs).toContain("/settings/domains");
  });

  it("matches keywords, not just labels", () => {
    const hrefs = filterSettingsGroups(all, "captcha").flatMap((g) => g.entries.map((e) => e.href));
    expect(hrefs).toEqual(["/settings/gateway"]);
  });

  it("shows a whole group when its name is typed", () => {
    const groups = filterSettingsGroups(all, "plugins");
    const plugins = groups.find((g) => g.id === "plugins");
    expect(plugins?.entries.length).toBe(
      SETTINGS_GROUPS.find((g) => g.id === "plugins")?.entries.length,
    );
  });

  it("returns nothing for gibberish and everything for blank", () => {
    expect(filterSettingsGroups(all, "zzzqqq")).toEqual([]);
    expect(filterSettingsGroups(all, "  ")).toHaveLength(SETTINGS_GROUPS.length);
  });
});

describe("settingsCrumbLabel", () => {
  it("names the section and its pages in the operator's words", () => {
    expect(settingsCrumbLabel("/settings")).toBe("Settings");
    expect(settingsCrumbLabel("/settings/ai")).toBe("AI provider & models");
    expect(settingsCrumbLabel("/settings/no-such-section/menu")).toBeNull();
  });
});
