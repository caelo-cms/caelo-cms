// SPDX-License-Identifier: MPL-2.0
/**
 * The prominent entry above the list. `/edit` itself opens for any
 * signed-in user; the nav offers it only to people who may edit.
 */
export const LIVE_EDIT = {
    href: "/edit",
    label: "Live edit",
    description: "See your site and change it by chat",
    icon: "wand",
    permission: "content.write",
};
export const DASHBOARD = {
    href: "/",
    label: "Dashboard",
    icon: "dashboard",
    permission: null,
};
/** Id of the collapsible group; also the `localStorage` key suffix. */
export const CONTENT_GROUP_ID = "content";
export const CONTENT_GROUP_LABEL = "Content";
/** Id of the plugin pages' collapsible group; also its `localStorage` key suffix. */
export const PLUGINS_GROUP_ID = "plugins";
export const PLUGINS_GROUP_LABEL = "Plugins";
export const CONTENT_LINKS = [
    // issue #620 — unstaged work across chats: Stage all / selected, Discard.
    { href: "/content/changes", label: "Open changes", icon: "changes", permission: "content.write" },
    { href: "/content/pages", label: "Pages", icon: "file", permission: "content.read" },
    { href: "/content/modules", label: "Modules", icon: "layers", permission: "content.read" },
    // Epic #1107 — menus, footer links, categories, tags: every shared list.
    { href: "/content/lists", label: "Menus & lists", icon: "list", permission: "content.read" },
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
export const SETTINGS_LINK = {
    href: "/settings",
    label: "Settings",
    icon: "settings",
    permission: null,
};
function canSee(perms, permission) {
    if (permission === null)
        return true;
    return Array.isArray(perms)
        ? perms.includes(permission)
        : perms.has(permission);
}
/**
 * Drops every link whose page the viewer cannot open.
 *
 * @param perms the viewer's effective permissions.
 * @param settingsVisible whether the viewer may open at least one Settings
 *   page (`hasAnySettingsAccess`); Settings has no single gate of its own.
 * @param pluginLinks the plugin panels this viewer may open
 *   (`pluginNavLinks`, computed on the server from the running plugins).
 */
export function visibleMainNav(perms, settingsVisible, pluginLinks) {
    return {
        liveEdit: canSee(perms, LIVE_EDIT.permission) ? LIVE_EDIT : null,
        dashboard: DASHBOARD,
        content: CONTENT_LINKS.filter((l) => canSee(perms, l.permission)),
        plugins: [...pluginLinks],
        settings: settingsVisible ? SETTINGS_LINK : null,
    };
}
/**
 * The href to highlight for `pathname`: the longest candidate that equals
 * the path or is a parent of it, so `/settings/deployments` lights up
 * Settings and `/content/pages/<id>` lights up Pages. `/` matches only
 * itself.
 */
export function activeNavHref(pathname, hrefs) {
    return (hrefs
        .filter((href) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)))
        .sort((a, b) => b.length - a.length)[0] ?? null);
}
