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
 * module, a layout, or a template. A URL inside a rendered list entry
 * (`data-caelo-list-item`, epic #1107) is stored in that entry: a shared
 * list's (`<listId>/<itemId>`) or a module field default's
 * (`local/<field>/<itemId>`); a placement's local list is a content value.
 */

import { truncateKeepingIds } from "@caelo-cms/shared";
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
  /** The rendered list entry it sits in (`data-caelo-list-item`), if any. */
  readonly listItem?: string | null;
}

export interface OriginContext {
  readonly modules: ReadonlyMap<string, LinkModule>;
  readonly layouts: readonly LinkLayout[];
}

type Origin =
  | { readonly kind: "theme-asset" }
  | { readonly kind: "plugin"; readonly slug: string }
  | { readonly kind: "module-template"; readonly module: LinkModule }
  | { readonly kind: "module-value"; readonly module: LinkModule }
  | { readonly kind: "layout"; readonly layout: LinkLayout }
  | { readonly kind: "chrome" }
  | { readonly kind: "list-entry"; readonly listId: string; readonly itemId: string }
  | {
      readonly kind: "field-default-entry";
      readonly module: LinkModule;
      readonly field: string;
      readonly itemId: string;
    };

const SHARED_ENTRY_RE = /^([0-9a-f-]{36})\/([0-9a-f-]{36})$/i;
const DEFAULT_ENTRY_RE = /^local\/([a-z][a-z0-9_]*)\/([0-9a-f-]{36})$/i;

function originOf(place: LinkPlace, ctx: OriginContext): Origin {
  if (place.raw.includes("{{theme_")) return { kind: "theme-asset" };
  if (place.pluginSlug) return { kind: "plugin", slug: place.pluginSlug };
  const module = place.moduleId ? ctx.modules.get(place.moduleId) : undefined;
  const shared = place.listItem ? SHARED_ENTRY_RE.exec(place.listItem) : null;
  if (shared?.[1] && shared[2]) return { kind: "list-entry", listId: shared[1], itemId: shared[2] };
  const local = place.listItem ? DEFAULT_ENTRY_RE.exec(place.listItem) : null;
  if (module && local?.[1] && local[2]) {
    return { kind: "field-default-entry", module, field: local[1], itemId: local[2] };
  }
  if (module) {
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
    case "module-template":
      return `in the template of module "${o.module.displayName}" (${o.module.id})`;
    case "module-value":
      return `in a content value of module "${o.module.displayName}" (${o.module.id})`;
    case "layout":
      return `in layout "${o.layout.displayName}" (${o.layout.id})`;
    case "chrome":
      return "in the page's template markup";
    case "list-entry":
      return `in entry ${o.itemId} of shared list ${o.listId}`;
    case "field-default-entry":
      return `in entry ${o.itemId} of the default of field "${o.field}" of module "${o.module.displayName}" (${o.module.id})`;
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
    case "module-template":
      return {
        tool: "edit_content",
        hint: clip(
          `in module "${o.module.displayName}" (${o.module.id}) html, replace "${place.raw}" with ${to} (read_content first) — one fix for every page the module is on`,
        ),
      };
    case "module-value":
      return {
        tool: "set_page_module_content_many",
        hint: clip(
          `the URL is a content value of module "${o.module.displayName}" (${o.module.id}) on this page: set it to ${to} (set_content_instance_values_many when the content is a shared instance)`,
        ),
      };
    case "layout":
      return {
        tool: "propose_update_layout",
        hint: clip(
          `replace "${place.raw}" in layout "${o.layout.displayName}" (${o.layout.id}) with ${to}`,
        ),
      };
    case "list-entry":
      return {
        tool: "patch_list_items_many",
        hint: clip(
          `the URL is stored in entry ${o.itemId} of shared list ${o.listId} (list_lists names it): update that entry's link to ${to} — one fix for every module that shows the list`,
        ),
      };
    case "field-default-entry":
      return {
        tool: "update_modules_many",
        hint: clip(
          `the URL is stored in entry ${o.itemId} of the default of list field "${o.field}" of module "${o.module.displayName}" (${o.module.id}): set that entry's link to ${to}`,
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
  return truncateKeepingIds(hint, 500);
}
