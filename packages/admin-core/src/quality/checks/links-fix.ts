// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #849 — where a link of the staged build is stored, and which tool
 * fixes it (CLAUDE.md §11: a finding names the next step, so the AI fixes
 * it without asking the operator).
 *
 * The rendered HTML says where a URL sits: inside a module root
 * (`data-caelo-module-id`), inside baked plugin output
 * (`data-caelo-plugin`), or in the page's chrome. The stored sources say
 * which layer holds it: a module's template, a content value of that
 * module, a navigation menu's structured set, a layout, or a template.
 */

import type { FindingFix } from "./findings.js";

/** A module as the link check needs it. */
export interface LinkModule {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  /** The template body, Mustache tags included. */
  readonly html: string;
}

/** A layout as the link check needs it. */
export interface LinkLayout {
  readonly id: string;
  readonly displayName: string;
  readonly html: string;
}

/** The part of a link occurrence the origin depends on. */
export interface LinkPlace {
  readonly raw: string;
  readonly moduleId: string | null;
  readonly pluginSlug: string | null;
}

export interface OriginContext {
  readonly modules: ReadonlyMap<string, LinkModule>;
  readonly layouts: readonly LinkLayout[];
}

/** Navigation menus render from the `nav-menu/<slug>` set, not their template. */
const NAV_MENU_PREFIX = "nav-menu-";

type Origin =
  | { readonly kind: "theme-asset" }
  | { readonly kind: "plugin"; readonly slug: string }
  | { readonly kind: "nav-menu"; readonly module: LinkModule; readonly set: string }
  | { readonly kind: "module-template"; readonly module: LinkModule }
  | { readonly kind: "module-value"; readonly module: LinkModule }
  | { readonly kind: "layout"; readonly layout: LinkLayout }
  | { readonly kind: "chrome" };

function originOf(place: LinkPlace, ctx: OriginContext): Origin {
  if (place.raw.includes("{{theme_")) return { kind: "theme-asset" };
  if (place.pluginSlug) return { kind: "plugin", slug: place.pluginSlug };
  const module = place.moduleId ? ctx.modules.get(place.moduleId) : undefined;
  if (module) {
    if (module.slug.startsWith(NAV_MENU_PREFIX)) {
      return {
        kind: "nav-menu",
        module,
        set: `nav-menu/${module.slug.slice(NAV_MENU_PREFIX.length)}`,
      };
    }
    return module.html.includes(place.raw)
      ? { kind: "module-template", module }
      : { kind: "module-value", module };
  }
  const layout = ctx.layouts.find((l) => l.html.includes(place.raw));
  return layout ? { kind: "layout", layout } : { kind: "chrome" };
}

/** Where the URL sits, for the finding's message ("in module …"). */
export function describeOrigin(place: LinkPlace, ctx: OriginContext): string {
  const o = originOf(place, ctx);
  switch (o.kind) {
    case "theme-asset":
      return "(an unbound theme asset)";
    case "plugin":
      return `in the output of plugin "${o.slug}"`;
    case "nav-menu":
      return `in navigation menu "${o.module.displayName}" (structured set ${o.set})`;
    case "module-template":
      return `in the template of module "${o.module.displayName}" (${o.module.id})`;
    case "module-value":
      return `in a content value of module "${o.module.displayName}" (${o.module.id})`;
    case "layout":
      return `in layout "${o.layout.displayName}" (${o.layout.id})`;
    case "chrome":
      return "in the page's template markup";
  }
}

/**
 * The tool that fixes a link finding at its origin.
 *
 * @param finalUrl - for a link through redirects: the URL to link instead.
 */
export function fixFor(
  ruleId: string,
  place: LinkPlace,
  ctx: OriginContext,
  finalUrl: string | null,
): FindingFix {
  if (ruleId === "links/redirect-loop") {
    return {
      tool: "bulk_create_redirects",
      hint: clip(
        `break the cycle: find its rows with find_redirects, upsert one so it ends at a live page (or remove it with bulk_delete_redirects), then point "${place.raw}" at that page`,
      ),
    };
  }
  const to =
    finalUrl !== null
      ? `"${finalUrl}"`
      : ruleId === "links/broken-asset"
        ? "a file that exists (find_media for media)"
        : "an existing page (list_pages); if the target is an unpublished page publish it with set_pages_status_many, if it moved keep the URL and add a redirect with bulk_create_redirects";
  const o = originOf(place, ctx);
  switch (o.kind) {
    case "theme-asset":
      return {
        tool: "set_theme_asset",
        hint: clip(`bind the theme asset ${place.raw} with set_theme_asset, then Stage again`),
      };
    case "plugin":
      return {
        tool: "get_plugin",
        hint: clip(
          `plugin "${o.slug}" renders "${place.raw}": check its data and settings with get_plugin and change the URL there to ${to}; if the plugin builds the URL itself, report it with bug_report`,
        ),
      };
    case "nav-menu":
      return {
        tool: "set_structured_set",
        hint: clip(`change the item whose href is "${place.raw}" in ${o.set} to ${to}`),
      };
    case "module-template":
      return {
        tool: "edit_content",
        hint: clip(
          `in module "${o.module.displayName}" (${o.module.id}) html, replace "${place.raw}" with ${to} (read_content first) — one fix for every page the module is on`,
        ),
      };
    case "module-value":
      return {
        tool: "set_page_module_content",
        hint: clip(
          `the URL is a content value of module "${o.module.displayName}" (${o.module.id}) on this page: set it to ${to} (set_content_instance_values when the content is a shared instance)`,
        ),
      };
    case "layout":
      return {
        tool: "propose_update_layout",
        hint: clip(
          `replace "${place.raw}" in layout "${o.layout.displayName}" (${o.layout.id}) with ${to}`,
        ),
      };
    case "chrome":
      return {
        tool: "grep_content",
        hint: clip(
          `find "${place.raw}" with grep_content (templates included) and change it to ${to} with edit_content; if nothing contains it, the build emitted it — Stage again and report it with bug_report if it persists`,
        ),
      };
  }
}

function clip(hint: string): string {
  return hint.length > 500 ? `${hint.slice(0, 499)}…` : hint;
}
