// SPDX-License-Identifier: MPL-2.0

import type { Permission } from "@caelo-cms/admin-core";

/**
 * The admin side navigation's information architecture.
 *
 * Live edit is how an operator builds, migrates and maintains a site, so it
 * is the one prominent entry. The list views (pages, modules, media, …) are
 * for looking things up, not for working; they sit in one collapsible
 * "Content" group. Everything an Owner configures lives behind Settings
 * (its own grouped overview, `settings-nav.ts`), and the personal Account
 * link sits in the sidebar footer next to Log out.
 *
 * Icons are string keys, mapped to lucide components by `AppShell.svelte`,
 * so this module stays importable by `bun test` without compiling Svelte.
 */

export type MainNavIcon =
  | "dashboard"
  | "wand"
  | "settings"
  | "content"
  | "changes"
  | "file"
  | "layers"
  | "package"
  | "image"
  | "layout"
  | "palette"
  | "type";

/** A link in the side nav. */
export interface MainNavLink {
  href: string;
  label: string;
  icon: MainNavIcon;
  /**
   * Who sees the link: for Content links, the permission the page's `load`
   * guard requires (`main-nav.test.ts` checks that). `null` = every
   * signed-in user. Settings is special-cased (any visible settings page)
   * by the caller passing `settingsVisible`.
   */
  permission: Permission | null;
}

/**
 * The prominent entry above the list. `/edit` itself opens for any
 * signed-in user; the nav offers it only to people who may edit.
 */
export const LIVE_EDIT: MainNavLink & { description: string } = {
  href: "/edit",
  label: "Live edit",
  description: "See your site and change it by chat",
  icon: "wand",
  permission: "content.write",
};

export const DASHBOARD: MainNavLink = {
  href: "/",
  label: "Dashboard",
  icon: "dashboard",
  permission: null,
};

/** Id of the collapsible group; also the `localStorage` key suffix. */
export const CONTENT_GROUP_ID = "content";

export const CONTENT_GROUP_LABEL = "Content";

export const CONTENT_LINKS: readonly MainNavLink[] = [
  // issue #620 — unstaged work across chats: Stage all / selected, Discard.
  { href: "/content/changes", label: "Open changes", icon: "changes", permission: "content.write" },
  { href: "/content/pages", label: "Pages", icon: "file", permission: "content.read" },
  { href: "/content/modules", label: "Modules", icon: "layers", permission: "content.read" },
  {
    href: "/content/library",
    label: "Content library",
    icon: "package",
    permission: "content.read",
  },
  { href: "/content/media", label: "Media", icon: "image", permission: "content.read" },
  { href: "/content/templates", label: "Templates", icon: "layout", permission: "content.read" },
  // v0.11.1 (issue #76) — theme edits affect every page on the site, so
  // they need roles.manage, the same gate as /settings/themes/pending.
  { href: "/design/themes", label: "Themes", icon: "palette", permission: "roles.manage" },
  { href: "/design/fonts", label: "Fonts", icon: "type", permission: "roles.manage" },
];

export const SETTINGS_LINK: MainNavLink = {
  href: "/settings",
  label: "Settings",
  icon: "settings",
  permission: null,
};

/** The nav as one viewer may see it. */
export interface VisibleMainNav {
  liveEdit: (MainNavLink & { description: string }) | null;
  dashboard: MainNavLink;
  content: MainNavLink[];
  settings: MainNavLink | null;
}

type PermissionSource = ReadonlySet<string> | readonly string[];

function canSee(perms: PermissionSource, permission: Permission | null): boolean {
  if (permission === null) return true;
  return Array.isArray(perms)
    ? perms.includes(permission)
    : (perms as ReadonlySet<string>).has(permission);
}

/**
 * Drops every link whose page the viewer cannot open.
 *
 * @param perms the viewer's effective permissions.
 * @param settingsVisible whether the viewer may open at least one Settings
 *   page (`hasAnySettingsAccess`); Settings has no single gate of its own.
 */
export function visibleMainNav(perms: PermissionSource, settingsVisible: boolean): VisibleMainNav {
  return {
    liveEdit: canSee(perms, LIVE_EDIT.permission) ? LIVE_EDIT : null,
    dashboard: DASHBOARD,
    content: CONTENT_LINKS.filter((l) => canSee(perms, l.permission)),
    settings: settingsVisible ? SETTINGS_LINK : null,
  };
}

/**
 * The href to highlight for `pathname`: the longest candidate that equals
 * the path or is a parent of it, so `/settings/deployments` lights up
 * Settings and `/content/pages/<id>` lights up Pages. `/` matches only
 * itself.
 */
export function activeNavHref(pathname: string, hrefs: readonly string[]): string | null {
  return (
    hrefs
      .filter((href) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}
