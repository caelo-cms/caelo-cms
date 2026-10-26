// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeNavHref,
  CONTENT_LINKS,
  DASHBOARD,
  LIVE_EDIT,
  SETTINGS_LINK,
  visibleMainNav,
} from "./main-nav.js";

const AUTHED_ROUTES = join(import.meta.dir, "..", "routes", "(authed)");

/** The first permission a `load` requires, from the page or its nearest layout. */
function guardPermission(href: string): string | null {
  const segments = href.split("/").filter(Boolean);
  for (let i = segments.length; i >= 1; i--) {
    const dir = join(AUTHED_ROUTES, ...segments.slice(0, i));
    for (const file of ["+page.server.ts", "+layout.server.ts"]) {
      if (i < segments.length && file === "+page.server.ts") continue;
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      const src = readFileSync(path, "utf8");
      const start = src.indexOf("export const load");
      if (start === -1) continue;
      // Only the load guard counts; form actions guard writes separately.
      const actions = src.indexOf("export const actions", start);
      const load = src.slice(start, actions === -1 ? undefined : actions);
      const hit = /requirePermission\(\s*locals,\s*"([a-z._]+)"/.exec(load)?.[1];
      if (hit) return hit;
    }
  }
  return null;
}

describe("main nav model", () => {
  const links = [LIVE_EDIT, DASHBOARD, ...CONTENT_LINKS];

  it("links only to pages that exist", () => {
    for (const l of [...links, SETTINGS_LINK]) {
      const dir = join(AUTHED_ROUTES, ...l.href.split("/").filter(Boolean));
      expect(existsSync(join(dir, "+page.svelte"))).toBe(true);
    }
  });

  it("gates each Content link by the permission its page's load requires", () => {
    // Live edit is left out on purpose: /edit opens for any signed-in user,
    // but the nav offers it only to people who may edit (content.write).
    for (const l of CONTENT_LINKS) {
      expect({ href: l.href, permission: guardPermission(l.href) }).toEqual({
        href: l.href,
        permission: l.permission,
      });
    }
  });

  it("has no ramp-up entry: setup and migration run in Live edit", () => {
    expect([...links, SETTINGS_LINK].some((l) => l.href === "/ramp-up")).toBe(false);
    expect(existsSync(join(AUTHED_ROUTES, "ramp-up"))).toBe(false);
  });

  it("shows an Owner every entry", () => {
    const nav = visibleMainNav(
      ["content.read", "content.write", "roles.manage", "settings.read"],
      true,
    );
    expect(nav.liveEdit?.href).toBe("/edit");
    expect(nav.content.map((l) => l.href)).toEqual(CONTENT_LINKS.map((l) => l.href));
    expect(nav.settings?.href).toBe("/settings");
  });

  it("hides Live edit, Open changes and design pages from a read-only reviewer", () => {
    const nav = visibleMainNav(new Set(["content.read"]), false);
    expect(nav.liveEdit).toBeNull();
    expect(nav.settings).toBeNull();
    expect(nav.content.map((l) => l.label)).toEqual([
      "Pages",
      "Modules",
      "Menus & lists",
      "Content library",
      "Media",
      "Templates",
    ]);
  });
});

describe("activeNavHref", () => {
  const hrefs = ["/edit", "/", "/content/pages", "/settings", "/account"];

  it("matches the longest parent of the path", () => {
    expect(activeNavHref("/content/pages/1234", hrefs)).toBe("/content/pages");
    expect(activeNavHref("/settings/deployments", hrefs)).toBe("/settings");
  });

  it("matches the dashboard only on the root path", () => {
    expect(activeNavHref("/", hrefs)).toBe("/");
    expect(activeNavHref("/content/chat", hrefs)).toBeNull();
  });

  it("does not treat a shared prefix as a parent", () => {
    expect(activeNavHref("/editor", hrefs)).toBeNull();
  });
});
