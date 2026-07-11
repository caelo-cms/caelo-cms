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

import { BASE_TECHNICAL_CSS } from "./base-css.js";
import type { ModuleFieldKind } from "./content.js";
import {
  applySlotReplacements,
  extractInnerOfTopLevelContentSlot,
  listSlotNames,
} from "./preview-scanner.js";
import { type LanguageSelectorOverride, renderLanguageSelector } from "./structured-sets.js";
import { renderTemplate, type TemplateField } from "./template-engine.js";
import { renderThemeCss as renderThemeCssFromTokens } from "./theme-render.js";
import type { ThemeDocument } from "./themes.js";

export interface ComposeModule {
  readonly moduleId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly html: string;
  readonly css: string;
  readonly js: string;
  /**
   * v0.4.0 module-field schema, extended in #71 to carry `kind` so
   * the shared template engine can dispatch text-list / link-list /
   * module-list / module sections. `kind` is optional for back-compat
   * with callers that haven't been updated; the engine treats absent
   * kinds as primitives (the legacy compose-path behaviour).
   *
   * When present, the composer substitutes `{{name}}` placeholders
   * in `html` with each field's `default` value before slot
   * replacement — without this, modules created via the AI-authored
   * extractor path (which mints `{{spantext}}` / `{{ctahref}}` etc.
   * with declared defaults) ship raw placeholders to the browser,
   * visible to visitors as literal `{{name}}` text.
   *
   * Per-placement overrides (content_instances.values) are applied
   * here via the `contentValues` field below. The chat-branched
   * preview path additionally walks nested-module refs in
   * preview-render before reaching here.
   */
  readonly fields?: readonly { name: string; kind?: ModuleFieldKind; default?: unknown }[];
  /**
   * PR #61 follow-up — per-placement content values from the bound
   * `content_instances.values` jsonb. When present, the composer
   * substitutes `{{name}}` placeholders with `contentValues[name]`
   * BEFORE falling back to `fields[].default`. Without this, AI-
   * authored modules that declare explicit fields (without a `default`)
   * but rely on per-placement values shipped raw `{{name}}` text to
   * visitors — the bug e2e-livedit's second Stage caught.
   */
  readonly contentValues?: Readonly<Record<string, unknown>>;
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

/**
 * P9 — language-selector context. The caller (preview op + static
 * generator) resolves the current page's per-locale URLs once and
 * threads them in. The composer renders the selector when a module
 * slug starts with `language-selector-`.
 */
export interface ComposeLanguageSelector {
  readonly availableLocales: ReadonlyArray<{
    code: string;
    displayName: string;
    href: string;
    isCurrent: boolean;
  }>;
}

/**
 * v0.11.0 — Theme context resolved by the preview op + static generator
 * (#45 Phase 3). Carries the active theme's DTCG tokens jsonb plus the
 * four asset URL resolutions (logo / logo-dark / favicon / social-share).
 *
 * The composer reads `tokens` to emit `<style data-source="theme">`;
 * `assets` are surfaced for modules that want to reference theme-bound
 * images (the dedicated `{{theme_logo_url}}` template binding lands in
 * v0.11.x — see #45's "Out of scope"; v0.11.0 only surfaces the URLs).
 */
export interface ComposeThemeAsset {
  readonly mediaId: string;
  readonly url: string;
}

export interface ComposeTheme {
  readonly tokens: ThemeDocument;
  readonly assets: {
    readonly logo: ComposeThemeAsset | null;
    readonly logoDark: ComposeThemeAsset | null;
    readonly favicon: ComposeThemeAsset | null;
    readonly socialShare: ComposeThemeAsset | null;
  };
}

/**
 * issue #150 — self-hosted web fonts resolved by the caller (font
 * resolver in admin-core; static generator + preview op thread the
 * same shape so both surfaces load identical fonts). `css` is the
 * @font-face block; `preloads` are woff2 URLs worth a
 * `<link rel="preload">` (body/heading faces, capped upstream).
 */
export interface ComposeFonts {
  readonly css: string;
  readonly preloads: readonly string[];
}

export interface ComposeInput {
  readonly templateHtml: string;
  readonly templateCss: string;
  readonly blocks: readonly ComposeBlock[];
  readonly structuredSets?: ComposeStructuredSets;
  readonly languageSelector?: ComposeLanguageSelector;
  /**
   * v0.11.0 — active theme threaded through from the preview op + static
   * generator. Undefined when no theme row exists OR when the caller
   * hasn't been migrated to the new primitive yet (renderer no-ops in
   * both cases, preserving legacy parity).
   */
  readonly theme?: ComposeTheme;
  /** issue #150 — resolved web fonts; undefined = system stacks only. */
  readonly fonts?: ComposeFonts;
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

/**
 * issue #150 — head fragment for resolved web fonts: preload links (the
 * `crossorigin` attribute is REQUIRED for font preloads even same-origin,
 * per the fetch spec's font-destination CORS rule) + the @font-face
 * block. Empty css with no preloads → null (system-stack-only theme).
 */
function fontsHeadFragment(fonts: ComposeFonts | undefined): string | null {
  if (fonts === undefined) return null;
  const links = fonts.preloads
    .map((href) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="${href}">`)
    .join("");
  const style =
    fonts.css.trim().length > 0 ? `<style data-source="fonts">${fonts.css}</style>` : "";
  const fragment = links + style;
  return fragment.length > 0 ? fragment : null;
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
      const langSelector = lookupLanguageSelector(m.slug, input);
      let baseHtml: string;
      if (navMenuItems !== null) {
        baseHtml = renderNavMenuHtml(navMenuItems);
      } else if (langSelector !== null) {
        baseHtml = langSelector;
      } else {
        baseHtml = applyFieldSubstitution(m.html, m.fields, m.contentValues, input.theme);
      }
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

  // issue #150 — @font-face + preloads before everything else so the
  // browser discovers font URLs as early as possible.
  const fontsFragment = fontsHeadFragment(input.fonts);
  if (fontsFragment !== null) {
    html = injectBefore(html, HEAD_CLOSE_RE, fontsFragment);
  }

  // v0.11.0 — theme tokens become CSS custom properties on :root + (when
  // dark variants exist) :root.dark. Goes first so module CSS can
  // `var(--color-primary)` and override. Pre-v0.11 read from
  // structured_sets["theme/site"]; now reads the active themes row
  // threaded through ComposeInput.theme.
  const themeCss = renderThemeCss(input.theme);
  if (themeCss !== null) {
    const styleTag = `<style data-source="theme">${themeCss}</style>`;
    html = injectBefore(html, HEAD_CLOSE_RE, styleTag);
  }
  // issue #151 — invisible technical baseline (see composePageWithLayout).
  html = injectBefore(
    html,
    HEAD_CLOSE_RE,
    `<style data-source="base">${BASE_TECHNICAL_CSS}</style>`,
  );

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

/**
 * P9 — return rendered language-selector HTML when a module's slug
 * starts with `language-selector-`. The set's items act as overrides
 * (relabel a locale, hide one); the available-locale list comes from
 * the caller via `input.languageSelector`. Returns null when the
 * module is not a language selector.
 *
 * Convention: a module slug `language-selector-header` resolves to
 * structuredSets[`language-selector/header`] for overrides, and the
 * rendered HTML lists every locale that has a published variant of
 * the current page.
 */
function lookupLanguageSelector(moduleSlug: string, input: ComposeInput): string | null {
  const prefix = "language-selector-";
  if (!moduleSlug.startsWith(prefix)) return null;
  if (!input.languageSelector || input.languageSelector.availableLocales.length === 0) {
    return null;
  }
  const setSlug = moduleSlug.slice(prefix.length);
  const overridesUnknown = input.structuredSets?.byKindSlug[`language-selector/${setSlug}`];
  const overrides = Array.isArray(overridesUnknown)
    ? (overridesUnknown as LanguageSelectorOverride[])
    : undefined;
  return renderLanguageSelector({
    availableLocales: input.languageSelector.availableLocales,
    overrides,
  });
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

/**
 * v0.11.0 — Render the active theme's DTCG tokens as `:root { … }` (+
 * optional `:root.dark { … }`) CSS. Returns null when no active theme
 * is threaded through, so the composer skips injecting an empty
 * `<style>` tag. The renderer itself lives in `theme-render.ts`; this
 * wrapper exists so the composer's call site stays readable + the
 * empty-tokens case (active row, `tokens={}`) emits a deterministic
 * empty shell rather than skipping the tag (observable absence in
 * DevTools, per #45's test-strategy "empty-active-theme" assertion).
 */
function renderThemeCss(theme: ComposeTheme | undefined): string | null {
  if (!theme) return null;
  // Empty-tokens case: emit the shell so cascade ordering stays
  // consistent (legacy "no theme/site row" case still returns null
  // above so the tag is skipped entirely).
  if (Object.keys(theme.tokens).length === 0) return ":root{}";
  return renderThemeCssFromTokens(theme.tokens);
}

/**
 * Substitute `{{name}}` placeholders and `{{#name}}…{{/name}}`
 * sections in module HTML. Thin wrapper around the shared template
 * engine (#71); see `template-engine.ts` for the full substitution
 * grammar and the loud-raw / failure-marker invariants.
 *
 * Compose is the no-DB path: nested-module field kinds (`module`,
 * `module-list`) cannot be resolved here because the partial loader
 * needs a DB walk to fetch nested content_instances. The engine
 * emits a loud HTML comment for those refs so static-gen output is
 * visible-broken (per CLAUDE.md §2) rather than silent-empty. The
 * chat-branched preview path resolves nested refs via
 * `preview-render.ts` BEFORE the substituted HTML reaches the
 * composer, so this branch never trips for that path. Issue #70
 * tracks pre-resolving in static-gen so the loud comment goes away
 * there too.
 *
 * Both `fields` and `contentValues` are optional. Field `kind` is
 * optional for back-compat with callers that haven't been updated;
 * the engine treats absent kinds as primitives (the legacy
 * compose-path behaviour).
 */
function applyFieldSubstitution(
  html: string,
  fields: readonly { name: string; kind?: ModuleFieldKind; default?: unknown }[] | undefined,
  contentValues: Readonly<Record<string, unknown>> | undefined,
  theme: ComposeTheme | undefined,
): string {
  if (!fields && !contentValues && !theme) return html;
  const engineFields: TemplateField[] = (fields ?? []).map((f) => ({
    name: f.name,
    kind: f.kind ?? "text",
    default: f.default,
  }));
  return renderTemplate({
    html,
    fields: engineFields,
    contentValues,
    // v0.11.1 (issue #76) — thread the active theme's asset URLs so
    // module HTML carrying `{{theme_logo_url}}` etc. resolves. Unbound
    // slots emit loud-raw + `theme-asset-unbound:<slot>` markers.
    themeAssets: theme
      ? {
          logo: theme.assets.logo?.url ?? null,
          logoDark: theme.assets.logoDark?.url ?? null,
          favicon: theme.assets.favicon?.url ?? null,
          socialShare: theme.assets.socialShare?.url ?? null,
        }
      : undefined,
    // Compose path has no DB; pass no partials so module/module-list
    // refs emit the loud HTML comment per CLAUDE.md §2.
  }).html;
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

/**
 * P6.7.6 — layout-aware composer. Runs the template composer first,
 * extracts the resulting body content, then renders the layout HTML
 * substituting:
 *   - `<caelo-slot name="content">` → the body of the rendered template
 *   - other layout blocks (header / footer / etc.) → concatenated HTML
 *     from `layoutBlocks` (per-block module attachments)
 *
 * Per CLAUDE.md §2 no-fallbacks: validates the layout has the required
 * `<caelo-slot name="content">` slot before rendering. Throws
 * `ComposeError` if the layout is malformed so callers (preview op +
 * static generator) surface it as a structured failure rather than
 * silently emitting broken HTML.
 */
export interface ComposeLayoutBlock {
  readonly blockName: string;
  readonly modules: readonly ComposeModule[];
}

export interface ComposeWithLayoutInput extends ComposeInput {
  readonly layoutHtml: string;
  readonly layoutCss: string;
  readonly layoutBlocks: readonly ComposeLayoutBlock[];
  /** Optional layout slug carried into ComposeError messages. */
  readonly layoutSlug?: string;
}

/**
 * Typed failure for the layout-aware composer. Use `kind` to dispatch:
 *   - `layout-missing-content`: the layout HTML lacks
 *     `<caelo-slot name="content">…</caelo-slot>` so the page body has
 *     nowhere to land.
 */
export class ComposeError extends Error {
  readonly kind: "layout-missing-content";
  readonly layoutSlug: string | undefined;
  constructor(kind: "layout-missing-content", message: string, layoutSlug?: string) {
    super(message);
    this.name = "ComposeError";
    this.kind = kind;
    this.layoutSlug = layoutSlug;
  }
}

const BODY_OPEN_RE = /<body\b[^>]*>/i;

/**
 * Extract the inner body HTML from a fully rendered template document.
 * If the template HTML has no <body> (legacy fragment templates), the
 * whole composed string is returned as-is — the layout's
 * `<caelo-slot name="content">` becomes a generic mount point and the
 * layout owns <html><head><body>.
 *
 * Legacy templates often wrap their slot in `<body><caelo-slot
 * name="content">…</caelo-slot></body>` — peel off the redundant
 * `<caelo-slot>` so we don't end up with the layout's own slot
 * containing yet another `<caelo-slot>`. The peel uses the same
 * htmlparser2 Parser as `applySlotReplacements` so quoting / attribute
 * ordering / whitespace variations are handled uniformly (the previous
 * regex silently fell through on `name='content'`, attr reordering,
 * etc., producing nested-slot output).
 */
function extractBodyInner(composedHtml: string): string {
  const open = BODY_OPEN_RE.exec(composedHtml);
  const close = BODY_CLOSE_RE.exec(composedHtml);
  let inner: string;
  if (!open || !close || close.index < open.index) {
    inner = composedHtml;
  } else {
    const start = open.index + open[0].length;
    inner = composedHtml.slice(start, close.index);
  }
  const peeled = extractInnerOfTopLevelContentSlot(inner);
  return peeled ?? inner;
}

export function composePageWithLayout(input: ComposeWithLayoutInput): ComposeOutput {
  // No-fallbacks (CLAUDE.md §2): validate the layout declares a
  // `content` slot up-front, before rendering. The htmlparser2-based
  // walk handles attribute quoting / ordering uniformly; a layout
  // without the slot is a misconfiguration that must surface to the
  // caller, not silently emit a body-less page.
  if (!listSlotNames(input.layoutHtml).includes("content")) {
    const slug = input.layoutSlug ?? "(unknown)";
    throw new ComposeError(
      "layout-missing-content",
      `layout "${slug}" is missing the required \`<caelo-slot name="content">\` slot — fix via /security/layouts`,
      input.layoutSlug,
    );
  }

  // CSS / JS aggregation order: layout (ground) → template (overrides
  // layout) → modules (highest specificity). The array's source order
  // drives cascade order in the emitted <style> tag, so we push in
  // priority sequence rather than mixing push + unshift (which is
  // brittle and reads as a bug).
  const cssParts: string[] = [];
  const jsParts: string[] = [];
  if (input.layoutCss.trim().length > 0) cssParts.push(input.layoutCss);
  if (input.templateCss.trim().length > 0) cssParts.push(input.templateCss);

  // 1. Render the page modules into the template (slot replacement only;
  //    no head/body manipulation here — that belongs to the layout).
  const templateContentByName = new Map<string, string>();
  for (const block of input.blocks) {
    const renderedModuleHtml = block.modules.map((m) => {
      const navMenuItems = lookupNavMenuItems(m.slug, input.structuredSets);
      const langSelector = lookupLanguageSelector(m.slug, input);
      let baseHtml: string;
      if (navMenuItems !== null) {
        baseHtml = renderNavMenuHtml(navMenuItems);
      } else if (langSelector !== null) {
        baseHtml = langSelector;
      } else {
        baseHtml = applyFieldSubstitution(m.html, m.fields, m.contentValues, input.theme);
      }
      return tagModuleId(baseHtml, m.moduleId);
    });
    templateContentByName.set(block.blockName, renderedModuleHtml.join("\n"));
    for (const m of block.modules) {
      if (m.css.trim().length > 0) cssParts.push(m.css);
      if (m.js.trim().length > 0) jsParts.push(m.js);
    }
  }
  const renderedTemplate = applySlotReplacements(input.templateHtml, {
    contentByName: templateContentByName,
  });
  const innerBody = extractBodyInner(renderedTemplate.html);

  // 2. Build per-layout-block contents (header / footer / etc.) +
  //    aggregate their CSS/JS at module specificity (already higher
  //    than layout/template because the layout/template parts went
  //    in first above).
  const layoutContentByName = new Map<string, string>();
  layoutContentByName.set("content", innerBody);
  for (const block of input.layoutBlocks) {
    if (block.blockName === "content") continue; // reserved for the page body
    const renderedModuleHtml = block.modules.map((m) => {
      const navMenuItems = lookupNavMenuItems(m.slug, input.structuredSets);
      const langSelector = lookupLanguageSelector(m.slug, input);
      let baseHtml: string;
      if (navMenuItems !== null) {
        baseHtml = renderNavMenuHtml(navMenuItems);
      } else if (langSelector !== null) {
        baseHtml = langSelector;
      } else {
        baseHtml = applyFieldSubstitution(m.html, m.fields, m.contentValues, input.theme);
      }
      return tagModuleId(baseHtml, m.moduleId);
    });
    layoutContentByName.set(block.blockName, renderedModuleHtml.join("\n"));
    for (const m of block.modules) {
      if (m.css.trim().length > 0) cssParts.push(m.css);
      if (m.js.trim().length > 0) jsParts.push(m.js);
    }
  }

  // 3. Render the layout HTML, substituting all named slots.
  const replaced = applySlotReplacements(input.layoutHtml, {
    contentByName: layoutContentByName,
  });
  let html = replaced.html;

  // issue #150 — fonts first (URL discovery), then theme vars, then
  // aggregated CSS; source order in <head> mirrors injection order.
  const fontsFragment = fontsHeadFragment(input.fonts);
  if (fontsFragment !== null) {
    html = injectBefore(html, HEAD_CLOSE_RE, fontsFragment);
  }
  const themeCss = renderThemeCss(input.theme);
  if (themeCss !== null) {
    html = injectBefore(html, HEAD_CLOSE_RE, `<style data-source="theme">${themeCss}</style>`);
  }
  // issue #151 — invisible technical baseline (reset only, zero design
  // opinion); module CSS follows and overrides trivially.
  html = injectBefore(
    html,
    HEAD_CLOSE_RE,
    `<style data-source="base">${BASE_TECHNICAL_CSS}</style>`,
  );
  if (cssParts.length > 0) {
    html = injectBefore(
      html,
      HEAD_CLOSE_RE,
      `<style data-source="modules">\n${cssParts.join("\n")}\n</style>`,
    );
  }
  if (jsParts.length > 0) {
    html = injectBefore(
      html,
      BODY_CLOSE_RE,
      `<script defer data-source="modules">\n${jsParts.join("\n")}\n</script>`,
    );
  }

  // De-duplicate slot accounting across both passes — the template's
  // `content` slot and the layout's `content` slot are conceptually the
  // same surface to a caller asking "did content get filled?".
  const replacedSet = new Set<string>([
    ...renderedTemplate.replacedSlots,
    ...replaced.replacedSlots,
  ]);
  const missingSet = new Set<string>([...renderedTemplate.missingSlots, ...replaced.missingSlots]);
  for (const name of replacedSet) missingSet.delete(name);
  return {
    html,
    replacedSlots: [...replacedSet],
    missingSlots: [...missingSet],
  };
}
