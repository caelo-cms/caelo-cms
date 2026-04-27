// SPDX-License-Identifier: MPL-2.0

/**
 * Compose a page's HTML from its template + module references.
 *
 * The composed output is what the admin preview iframe renders. Production
 * static-gen (P6) will reuse this same composer once Astro is wired up, so the
 * function is pure and dependency-free — no DB calls, no IO. The Query API op
 * does the loads and hands the data here.
 *
 * Output shape:
 *   1. `<caelo-slot name="X">` blocks have their inner HTML replaced by the
 *      concatenated module HTML for block X (in `position` order).
 *   2. All module CSS is concatenated into a single
 *      `<style data-source="modules">` injected before `</head>` — template
 *      stays the source of truth for `<head>`; we just append.
 *   3. All module JS is concatenated into a single
 *      `<script defer data-source="modules">` injected before `</body>`.
 *   4. Template CSS is injected ahead of module CSS so module rules can
 *      override template defaults via specificity.
 *
 * The composer never escapes module HTML — modules ARE the place where raw
 * HTML lives (CMS_REQUIREMENTS §3.1). Templates ARE the place where the
 * `<head>` skeleton lives. Sandboxing happens one layer up (preview iframe in
 * the admin; in P11, plugin Web Components inside Shadow DOM).
 */

import { applySlotReplacements } from "./preview-scanner.js";

export interface ComposeModule {
  readonly moduleId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly html: string;
  readonly css: string;
  readonly js: string;
}

export interface ComposeBlock {
  readonly blockName: string;
  readonly modules: readonly ComposeModule[];
}

/** P6.7.5 — structured sets carried into the composer so nav-menu
 *  modules render from typed items and theme tokens flow into <head>. */
export interface ComposeStructuredSets {
  /** Map keyed by `<kind>/<slug>` (e.g. `nav-menu/header-main`). */
  readonly byKindSlug: Readonly<Record<string, readonly unknown[]>>;
}

export interface ComposeInput {
  readonly templateHtml: string;
  readonly templateCss: string;
  readonly blocks: readonly ComposeBlock[];
  readonly structuredSets?: ComposeStructuredSets;
}

export interface ComposeOutput {
  readonly html: string;
  readonly replacedSlots: readonly string[];
  readonly missingSlots: readonly string[];
}

const HEAD_CLOSE_RE = /<\/head\s*>/i;
const BODY_CLOSE_RE = /<\/body\s*>/i;

function injectBefore(source: string, marker: RegExp, fragment: string): string {
  const m = marker.exec(source);
  if (!m) return source + fragment; // template lacks the tag — append as fallback
  const idx = m.index;
  return source.slice(0, idx) + fragment + source.slice(idx);
}

export function composePagePreview(input: ComposeInput): ComposeOutput {
  const contentByName = new Map<string, string>();
  const allCss: string[] = [];
  const allJs: string[] = [];
  // Template CSS first so module CSS can override it via source-order specificity.
  if (input.templateCss.trim().length > 0) allCss.push(input.templateCss);

  for (const block of input.blocks) {
    // P6.7 — tag every module's outermost element with
    // `data-caelo-module-id="<uuid>"` so the live-edit overlay's iframe
    // hover affordances can identify the clicked module.
    //
    // P6.7.5 — modules whose slug matches a `nav-menu/<slug>` set get
    // their HTML replaced by a fresh render of the menu items. That's
    // what makes a slug change update every menu without touching
    // module HTML.
    const renderedModuleHtml = block.modules.map((m) => {
      const navMenuItems = lookupNavMenuItems(m.slug, input.structuredSets);
      const baseHtml = navMenuItems !== null ? renderNavMenuHtml(navMenuItems) : m.html;
      return tagModuleId(baseHtml, m.moduleId);
    });
    const html = renderedModuleHtml.join("\n");
    contentByName.set(block.blockName, html);
    for (const m of block.modules) {
      if (m.css.trim().length > 0) allCss.push(m.css);
      if (m.js.trim().length > 0) allJs.push(m.js);
    }
  }

  const replaced = applySlotReplacements(input.templateHtml, { contentByName });
  let html = replaced.html;

  // P6.7.5 — theme tokens become CSS custom properties on :root. Goes
  // first so module CSS can `var(--color-primary)` and override.
  const themeCss = renderThemeCss(input.structuredSets);
  if (themeCss !== null) {
    const styleTag = `<style data-source="theme">${themeCss}</style>`;
    html = injectBefore(html, HEAD_CLOSE_RE, styleTag);
  }

  if (allCss.length > 0) {
    const styleTag = `<style data-source="modules">\n${allCss.join("\n")}\n</style>`;
    html = injectBefore(html, HEAD_CLOSE_RE, styleTag);
  }
  if (allJs.length > 0) {
    const scriptTag = `<script defer data-source="modules">\n${allJs.join("\n")}\n</script>`;
    html = injectBefore(html, BODY_CLOSE_RE, scriptTag);
  }

  return {
    html,
    replacedSlots: replaced.replacedSlots,
    missingSlots: replaced.missingSlots,
  };
}

/**
 * Insert `data-caelo-module-id="<id>"` into the first opening tag of
 * the module's HTML. Idempotent — re-tagging an already-tagged module
 * is a no-op. Comments / DOCTYPE / leading whitespace before the first
 * tag are tolerated. Modules that have no opening tag (pure text)
 * return unchanged because there's nothing to attach to.
 *
 * Exported so callers (admin preview endpoint, static generator,
 * tests) can reuse the same logic.
 */
/**
 * P6.7.5 — return the items for a `nav-menu/<slug>` set when a module's
 * slug starts with `nav-menu-`. Returns null when the module is not a
 * nav menu (so the composer falls back to its stored HTML).
 *
 * Convention: a module slug `nav-menu-header-main` resolves to
 * structuredSets[`nav-menu/header-main`].
 */
function lookupNavMenuItems(
  moduleSlug: string,
  sets: ComposeStructuredSets | undefined,
): readonly unknown[] | null {
  if (!sets) return null;
  const prefix = "nav-menu-";
  if (!moduleSlug.startsWith(prefix)) return null;
  const setSlug = moduleSlug.slice(prefix.length);
  const items = sets.byKindSlug[`nav-menu/${setSlug}`];
  return items ?? null;
}

interface NavMenuItem {
  label: string;
  href: string;
  target?: "_self" | "_blank";
  children?: NavMenuItem[];
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a nav-menu's typed items into HTML. Recursively handles
 * children for submenus. Plain `<nav><ul><li>` so site CSS can theme
 * it via the `caelo-nav-menu` class.
 */
function renderNavMenuHtml(items: readonly unknown[]): string {
  const safeItems = items.filter((it): it is NavMenuItem => {
    if (!it || typeof it !== "object") return false;
    const o = it as { label?: unknown; href?: unknown };
    return typeof o.label === "string" && typeof o.href === "string";
  });
  return `<nav class="caelo-nav-menu"><ul>${safeItems.map(renderNavItem).join("")}</ul></nav>`;
}
function renderNavItem(item: NavMenuItem): string {
  const target = item.target === "_blank" ? ' target="_blank" rel="noopener"' : "";
  const inner =
    item.children && item.children.length > 0
      ? `<ul>${item.children.map(renderNavItem).join("")}</ul>`
      : "";
  return `<li><a href="${escapeAttr(item.href)}"${target}>${escapeText(item.label)}</a>${inner}</li>`;
}

interface ThemeTokenItem {
  token: string;
  value: string;
}
/**
 * Render the theme/site set's tokens as `:root { --token: value; }` CSS.
 * Returns null when no theme is configured so the composer skips
 * injecting an empty <style> tag.
 */
function renderThemeCss(sets: ComposeStructuredSets | undefined): string | null {
  if (!sets) return null;
  const items = sets.byKindSlug["theme/site"];
  if (!items || items.length === 0) return null;
  const tokens = items.filter((it): it is ThemeTokenItem => {
    if (!it || typeof it !== "object") return false;
    const o = it as { token?: unknown; value?: unknown };
    return typeof o.token === "string" && typeof o.value === "string";
  });
  if (tokens.length === 0) return null;
  return `:root{${tokens.map((t) => `--${t.token}: ${t.value};`).join("")}}`;
}

export function tagModuleId(html: string, moduleId: string): string {
  if (!html) return html;
  const firstOpen = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/;
  const m = firstOpen.exec(html);
  if (!m) return html;
  // Already tagged?
  const tagAttrs = m[2] ?? "";
  if (/\sdata-caelo-module-id\s*=/.test(tagAttrs)) return html;
  const replaced = `<${m[1]}${tagAttrs} data-caelo-module-id="${moduleId}">`;
  return html.slice(0, m.index) + replaced + html.slice(m.index + m[0].length);
}
