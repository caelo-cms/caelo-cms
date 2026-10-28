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
import { findInteractionIds, interactionAssets } from "./interactions.js";
import { type LinkResolver, resolveLinkRefsInHtml } from "./link-refs.js";
import type { ListPageContext } from "./lists/resolve.js";
import { MODULE_ID_ATTRIBUTE, tagModuleId } from "./module-id-tag.js";
import {
  type NestedModuleResource,
  type NestedRenderFailure,
  type NestedRenderResolver,
  renderPlacedModule,
} from "./nested-module-render.js";
import {
  applySlotReplacements,
  extractInnerOfTopLevelContentSlot,
  listSlotNames,
} from "./preview-scanner.js";
import { escapeStyleText, scriptNeedsEncoding, utf8ToBase64 } from "./raw-text-escape.js";
import { stripCdataGuards } from "./strip-cdata.js";
import { balanceTemplateCloses } from "./template-balance.js";
import { renderTemplate, type TemplateField } from "./template-engine.js";
import { renderThemeCss as renderThemeCssFromTokens } from "./theme-render.js";
import type { ThemeDocument } from "./themes.js";

// Re-exported so existing callers keep importing it from the composer.
export { tagModuleId };

export interface ComposeModule {
  readonly moduleId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly html: string;
  readonly css: string;
  readonly js: string;
  /**
   * v0.4.0 module-field schema, extended in #71 to carry `kind` so
   * the shared template engine can dispatch list / module-list /
   * module sections (a `list` field carries its binding too). `kind` is optional for back-compat
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
   * here via the `contentValues` field below. Nested-module refs
   * render through `ComposeInput.nestedModules`.
   */
  readonly fields?: readonly ComposeField[];
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
  /**
   * The stored content instance `contentValues` come from — the address
   * of the module's local list entries (overlays, `data-caelo-list-item`).
   * Absent for site chrome rendered from field defaults and for content
   * variants, which are no stored instance.
   */
  readonly contentInstanceId?: string;
}

/** A module field as the composer passes it to the engine; `kind` absent = primitive. */
export type ComposeField = Omit<TemplateField, "kind"> & { readonly kind?: ModuleFieldKind };

export interface ComposeBlock {
  readonly blockName: string;
  readonly modules: readonly ComposeModule[];
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
  /**
   * Content type of the bytes the URL serves: `media_assets.mime` for the
   * `orig` URL, `image/png` for a raster favicon's rendition (see
   * `themeFaviconRendition`). Carried so `<head>` metadata that declares
   * a type (`<link rel="icon" type=…>`) states the real one.
   */
  readonly mime: string;
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
  /**
   * v0.11.0 — active theme threaded through from the preview op + static
   * generator. Undefined when no theme row exists OR when the caller
   * hasn't been migrated to the new primitive yet (renderer no-ops in
   * both cases, preserving legacy parity).
   */
  readonly theme?: ComposeTheme;
  /** issue #150 — resolved web fonts; undefined = system stacks only. */
  readonly fonts?: ComposeFonts;
  /**
   * The list view of the page being composed (`lists/resolve.ts`
   * `createListRenderContext(data).forPage(pageId, …)`): resolves `list`
   * fields — local, shared, query, system and plugin sources — and
   * `{{page.*}}` in every placed, nested and chrome module alike, so a
   * menu renders the same in the editor and on deploy, including the
   * loud marker when its plugin source is off.
   */
  readonly lists?: ListPageContext;
  /**
   * #450 — modules withheld by a plugin, keyed by module id. Resolved
   * by the host before composing; absent means the module renders
   * normally, which is the case for every module on a site with no
   * gating plugin active.
   */
  readonly deferredModules?: Readonly<Record<string, ComposeDeferral>>;
  /**
   * Every module and content instance a `module` / `module-list` field
   * can reference, batch-loaded by the caller (the static generator).
   * With it, nested modules render through the same recursive renderer
   * the editor preview uses, and their CSS/JS joins the page bundles.
   * Without it, a nested ref renders as a loud comment and a
   * `nested-renderer-unavailable` failure.
   */
  readonly nestedModules?: NestedRenderResolver;
  /**
   * Epic #724 — resolves internal references (`caelo:page/<id>`,
   * `caelo:media/<id>`) for THIS page: in every placed and nested
   * module and in list entries. A broken reference becomes a
   * `link-target-missing:<kind>/<id>` module failure; without a resolver
   * every reference fails with `link-resolver-unavailable` (loud — a
   * deploy refuses it).
   */
  readonly linkResolver?: LinkResolver;
}

/**
 * A failure marker raised while rendering one placed module (or a
 * module nested inside it) — the structured twin of the
 * `<!-- caelo:missing … -->` comments in the HTML. Deploy builds refuse
 * pages that carry any; see the static generator.
 */
export interface ComposeModuleFailure {
  readonly blockName: string;
  readonly moduleId: string;
  readonly moduleSlug: string;
  /** Field trail inside the module; empty when the marker names the field. */
  readonly field: string;
  readonly reason: string;
}

export interface ComposeOutput {
  readonly html: string;
  readonly replacedSlots: readonly string[];
  readonly missingSlots: readonly string[];
  /** Per-module failure markers, in render order. */
  readonly moduleFailures: readonly ComposeModuleFailure[];
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
 * Exported for the design-draft theme shell (#375) so draft previews
 * load the identical fonts as the page preview.
 */
export function fontsHeadFragment(fonts: ComposeFonts | undefined): string | null {
  if (fonts === undefined) return null;
  const links = fonts.preloads
    .map((href) => {
      const format = /\.(woff2?|ttf|otf)(?:[?#]|$)/.exec(href)?.[1];
      return `<link rel="preload" as="font"${format ? ` type="font/${format}"` : ""} crossorigin href="${escapeAttr(href)}">`;
    })
    .join("");
  const safeCss = escapeStyleText(fonts.css);
  const style = safeCss.trim().length > 0 ? `<style data-source="fonts">${safeCss}</style>` : "";
  const fragment = links + style;
  return fragment.length > 0 ? fragment : null;
}

/**
 * Head fragment for the active theme's document-level brand metadata:
 * `<link rel="icon">` when a favicon is bound. The favicon is page
 * METADATA, not body content — it must sit in `<head>` on every page
 * regardless of which layout or chrome modules the page uses, so the
 * composer emits it from the theme binding instead of relying on a
 * module to carry the tag. The href is the media URL as composed
 * (`/_caelo/media/<slug>/icon-64` for a raster favicon, the `orig` URL
 * for ICO/SVG — see `themeFaviconRendition`); the static generator's media pass rewrites
 * it to the published `/_assets/<slug>.<hash>.<ext>` and copies the bytes, the
 * same as any other media reference. Returns null when no theme is
 * threaded or no favicon is bound (nothing to declare; browsers fall
 * back to their own `/favicon.ico` probe exactly as before).
 */
function themeHeadFragment(theme: ComposeTheme | undefined): string | null {
  const favicon = theme?.assets.favicon;
  if (!favicon) return null;
  return `<link rel="icon" href="${escapeAttr(favicon.url)}" type="${escapeAttr(favicon.mime)}">`;
}

export function composePagePreview(input: ComposeInput): ComposeOutput {
  // No withholding path here; rendering a withheld module would ship it
  // ungated, so refuse instead of degrading silently (CLAUDE.md §2).
  if (input.deferredModules && Object.keys(input.deferredModules).length > 0) {
    throw new Error(
      "composePagePreview cannot withhold modules; compose pages with deferrals through composePageWithLayout",
    );
  }
  const contentByName = new Map<string, string>();
  const allCss: string[] = [];
  const allJs: string[] = [];
  // issue #158 — same per-module dedup as composePageWithLayout.
  const seenAssetModules = new Set<string>();
  const moduleFailures: ComposeModuleFailure[] = [];
  const nestedAssetIds: string[] = [];
  // Template CSS first so module CSS can override it via source-order specificity.
  if (input.templateCss.trim().length > 0) allCss.push(input.templateCss);

  for (const block of input.blocks) {
    // P6.7 — tag every module's outermost element with
    // `data-caelo-module-id="<uuid>"` so the live-edit overlay's iframe
    // hover affordances can identify the clicked module.
    const renderedModuleHtml = block.modules.map((m) => {
      const rendered = renderModuleFields(m, input);
      recordFailures(moduleFailures, block.blockName, m, rendered.failures);
      nestedAssetIds.push(...rendered.nestedModuleIds);
      return tagModuleId(rendered.html, m.moduleId);
    });
    const html = renderedModuleHtml.join("\n");
    contentByName.set(block.blockName, html);
    for (const m of block.modules) {
      if (seenAssetModules.has(m.moduleId)) continue;
      seenAssetModules.add(m.moduleId);
      if (m.css.trim().length > 0) allCss.push(m.css);
      if (m.js.trim().length > 0) allJs.push(m.js);
    }
    for (const id of nestedAssetIds.splice(0)) {
      if (seenAssetModules.has(id)) continue;
      seenAssetModules.add(id);
      const nested = input.nestedModules?.getModule(id);
      if (!nested) continue;
      if (nested.css.trim().length > 0) allCss.push(nested.css);
      if (nested.js.trim().length > 0) allJs.push(nested.js);
    }
  }

  const replaced = applySlotReplacements(input.templateHtml, { contentByName });
  let html = replaced.html;
  // issue #160 — see composePageWithLayout.
  const interactions = interactionAssets(new Set(findInteractionIds(html).known));
  allCss.push(...interactions.css);
  allJs.push(...interactions.js);

  // Theme brand metadata (favicon) leads the injected head block — it
  // is document metadata, not styling, and is independent of the
  // cascade order the style tags below depend on.
  const themeHeadLinks = themeHeadFragment(input.theme);
  if (themeHeadLinks !== null) {
    html = injectBefore(html, HEAD_CLOSE_RE, themeHeadLinks);
  }

  // issue #150 — @font-face + preloads ahead of the style tags so the
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
    const styleTag = `<style data-source="modules">\n${escapeStyleText(allCss.join("\n"))}\n</style>`;
    html = injectBefore(html, HEAD_CLOSE_RE, styleTag);
  }
  if (allJs.length > 0) {
    const joinedJs = allJs.join("\n");
    const scriptTag = scriptNeedsEncoding(joinedJs)
      ? `<script defer data-source="modules" src="data:text/javascript;base64,${utf8ToBase64(joinedJs)}"></script>`
      : `<script defer data-source="modules">\n${joinedJs}\n</script>`;
    html = injectBefore(html, BODY_CLOSE_RE, scriptTag);
  }

  return {
    html,
    replacedSlots: replaced.replacedSlots,
    missingSlots: replaced.missingSlots,
    moduleFailures,
  };
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

/** What rendering one placed module's fields produced. */
interface RenderedModuleFields {
  readonly html: string;
  readonly failures: readonly NestedRenderFailure[];
  /** Nested modules rendered inside it, in first-seen order. */
  readonly nestedModuleIds: readonly string[];
}

/**
 * Substitute `{{name}}` placeholders and `{{#name}}…{{/name}}`
 * sections in a placed module's HTML. Thin wrapper around the shared
 * template engine (#71); see `template-engine.ts` for the full
 * substitution grammar and the loud-raw / failure-marker invariants.
 *
 * Nested-module field kinds (`module`, `module-list`) render through
 * the recursive renderer (`nested-module-render.ts`, the one the editor
 * preview uses) when the caller supplied `nestedModules`. Without it
 * the engine emits a loud comment plus a `nested-renderer-unavailable`
 * failure (CLAUDE.md §2) — visible-broken, never silent-empty. The
 * editor preview pre-renders its page modules through the same renderer
 * before they reach the composer, so their `html` arrives substituted
 * and with no `fields`.
 *
 * Both `fields` and `contentValues` are optional. Field `kind` is
 * optional for back-compat with callers that haven't been updated;
 * the engine treats absent kinds as primitives (the legacy
 * compose-path behaviour).
 */
function renderModuleFields(
  m: ComposeModule,
  input: {
    readonly theme?: ComposeTheme;
    readonly lists?: ListPageContext;
    readonly nestedModules?: NestedRenderResolver;
    readonly linkResolver?: LinkResolver;
  },
): RenderedModuleFields {
  // The substitution engine (renderTemplate) already unwraps CDATA
  // guards; cover the no-op early-return path so a chrome module with no
  // fields/values/theme is cleaned too. A list context means the HTML
  // may iterate a plugin source or read `{{page.*}}` without any field.
  if (!m.fields && !m.contentValues && !input.theme && !input.lists) {
    // Still resolve references: pre-rendered (editor preview) and
    // field-less chrome modules carry links in their raw HTML too.
    const missing: string[] = [];
    const html = resolveLinkRefsInHtml(stripCdataGuards(m.html), input.linkResolver, missing);
    return {
      html,
      failures: missing.map((reason) => ({ field: "", reason })),
      nestedModuleIds: [],
    };
  }
  const fields: TemplateField[] = (m.fields ?? []).map((f) => ({ ...f, kind: f.kind ?? "text" }));
  // v0.11.1 (issue #76) — thread the active theme's asset URLs so
  // module HTML carrying `{{theme_logo_url}}` etc. resolves. Unbound
  // slots emit loud-raw + `theme-asset-unbound:<slot>` markers.
  const themeAssets = input.theme
    ? {
        logo: input.theme.assets.logo?.url ?? null,
        logoDark: input.theme.assets.logoDark?.url ?? null,
        favicon: input.theme.assets.favicon?.url ?? null,
        socialShare: input.theme.assets.socialShare?.url ?? null,
      }
    : undefined;
  if (input.nestedModules) {
    const r = renderPlacedModule(
      {
        html: m.html,
        fields,
        values: m.contentValues ?? {},
      },
      input.nestedModules,
      {
        themeAssets,
        ...(input.lists ? { lists: input.lists } : {}),
        ...(m.contentInstanceId ? { contentInstanceId: m.contentInstanceId } : {}),
        ...(input.linkResolver ? { linkResolver: input.linkResolver } : {}),
      },
    );
    return { html: r.html, failures: r.failures, nestedModuleIds: [...r.touchedModuleIds] };
  }
  const r = renderTemplate({
    html: m.html,
    fields,
    contentValues: m.contentValues,
    ...(input.lists ? { lists: input.lists } : {}),
    listHolder: { contentInstanceId: m.contentInstanceId ?? null },
    themeAssets,
    linkResolver: input.linkResolver,
  });
  return {
    html: r.html,
    failures: r.missingSlots.map((reason) => ({ field: "", reason })),
    nestedModuleIds: [],
  };
}

function recordFailures(
  out: ComposeModuleFailure[],
  blockName: string,
  m: ComposeModule,
  failures: readonly NestedRenderFailure[],
): void {
  for (const f of failures) {
    out.push({ blockName, moduleId: m.moduleId, moduleSlug: m.slug, ...f });
  }
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
/**
 * A module withheld from this render, as resolved by the plugin host
 * (#450). The composer never decides this — it only knows the verdict.
 */
export type ComposeDeferral = ComposeGateDeferral | ComposeOmitDeferral;

/** Withheld behind a placeholder until the plugin's runtime releases it. */
export interface ComposeGateDeferral {
  readonly pluginSlug: string;
  readonly reason: string;
  readonly placeholderModuleSlug: string;
  readonly placeholderHtml: string;
  readonly placeholderCss: string;
  readonly omit?: undefined;
}

/**
 * Left out entirely: nothing on the visitor's side can release it. The
 * plugin host passes the editor notice only to the editor preview; a
 * build gets `null` and the module's place stays empty.
 */
export interface ComposeOmitDeferral {
  readonly pluginSlug: string;
  readonly reason: string;
  readonly omit: true;
  readonly editorNotice: { readonly html: string; readonly css: string } | null;
}

/**
 * Emit a withheld module: the visible placeholder, plus the real markup
 * parked in an inert `<template>`.
 *
 * `<template>` is the whole point. Browsers parse its contents but
 * instantiate nothing — no image, iframe, script or stylesheet inside
 * one is ever fetched. So a video module behind a consent gate does not
 * touch YouTube until the plugin's runtime clones the content out,
 * which is a fact about the network rather than a promise about the
 * DOM. Hiding the module with CSS or stripping attributes in script
 * would both leave the request already sent.
 *
 * The module's CSS and JS go into the same `<template>` and NEVER into
 * the page-wide bundles: a `url(https://maps.gstatic.com/…)` in its CSS
 * or a `fetch()` in its JS reaches the vendor exactly as surely as an
 * `<iframe src>` does. The JS is parked as `type="text/plain"` (inert
 * even once cloned) and the plugin runtime executes it once per module,
 * after the markup it expects is in the DOM.
 *
 * The same holds for the modules nested inside it (its `module` /
 * `module-list` fields): their markup is already part of `moduleHtml`,
 * and their CSS/JS ride in the same `<template>`, each script under its
 * own module id, so the runtime runs every one of them once.
 */
function wrapDeferredModule(
  moduleHtml: string,
  module: Pick<ComposeModule, "moduleId" | "slug" | "css" | "js">,
  nestedModules: readonly Pick<NestedModuleResource, "moduleId" | "css" | "js">[],
  deferral: ComposeGateDeferral,
): string {
  // Inside the inert <template>, only an element's own end tag ends a
  // <style> / <script>; a `</template` there is text. So CSS needs just
  // its own close escaped, JS that could end its <script> ships base64
  // (the runtime decodes it, see consent-manager runtime.ts), and the
  // markup needs its unmatched `</template>` closes neutralized
  // (balanced nested templates stay).
  const safeHtml = balanceTemplateCloses(moduleHtml);
  const gated = [module, ...nestedModules];
  const css = gated
    .filter((g) => g.css.trim().length > 0)
    .map((g) => `<style data-source="module">${escapeStyleText(g.css)}</style>`)
    .join("");
  const js = gated
    .filter((g) => g.js.trim().length > 0)
    .map((g) =>
      scriptNeedsEncoding(g.js)
        ? `<script type="text/plain" data-caelo-deferred-script="${attr(g.moduleId)}" data-caelo-encoding="base64">${utf8ToBase64(g.js)}</script>`
        : `<script type="text/plain" data-caelo-deferred-script="${attr(g.moduleId)}">${g.js}</script>`,
    )
    .join("");
  return [
    `<div data-caelo-deferred="${attr(deferral.pluginSlug)}" data-reason="${attr(deferral.reason)}" data-module="${attr(module.slug)}">`,
    `<div data-caelo-deferred-placeholder>${deferral.placeholderHtml}</div>`,
    `<template data-caelo-deferred-content>${css}${safeHtml}${js}</template>`,
    `</div>`,
  ].join("");
}

/**
 * Emit an omitted module: nothing in a build, the editor notice in the
 * preview. The module's markup, CSS and JS never reach the page — not
 * even in a `<template>`, since nothing would ever clone it out. The
 * notice carries the module id (and its slug as the label) so the
 * editor's chat affordances reference the module it stands in for.
 */
function omittedModuleNotice(
  module: Pick<ComposeModule, "moduleId" | "slug">,
  deferral: ComposeOmitDeferral,
): string {
  if (deferral.editorNotice === null) return "";
  return `<div data-caelo-deferred="${attr(deferral.pluginSlug)}" data-reason="${attr(deferral.reason)}" data-module="${attr(module.slug)}" data-caelo-deferred-omitted ${MODULE_ID_ATTRIBUTE}="${attr(module.moduleId)}" aria-label="${attr(module.slug)}">${deferral.editorNotice.html}</div>`;
}

function attr(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

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
 *   - `nested-module-deferred`: a plugin withholds a module that sits
 *     INSIDE another module's `module` / `module-list` field. Only placed
 *     modules can be parked behind the plugin's gate, so rendering it
 *     would ship the withheld content ungated.
 */
export type ComposeErrorKind = "layout-missing-content" | "nested-module-deferred";

export class ComposeError extends Error {
  readonly kind: ComposeErrorKind;
  readonly layoutSlug: string | undefined;
  constructor(kind: ComposeErrorKind, message: string, layoutSlug?: string) {
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
      `layout "${slug}" is missing the required \`<caelo-slot name="content">\` slot — fix via /settings/layouts`,
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
  // issue #158 — a module placed N times contributes its CSS/JS ONCE
  // (first occurrence wins; source order is otherwise preserved).
  // Duplicate rule blocks made the cascade order-dependent and bloated
  // every page the same module appeared on twice.
  const seenAssetModules = new Set<string>();
  // Placeholder and notice CSS: one withheld module's placeholder used
  // on five placements is emitted once.
  const deferredCss = new Set<string>();
  const moduleFailures: ComposeModuleFailure[] = [];
  // Nested modules rendered since the last asset flush (see flushNestedAssets).
  const nestedAssetIds: string[] = [];
  if (input.layoutCss.trim().length > 0) cssParts.push(input.layoutCss);
  if (input.templateCss.trim().length > 0) cssParts.push(input.templateCss);

  // 1. Render the page modules into the template (slot replacement only;
  //    no head/body manipulation here — that belongs to the layout).
  const templateContentByName = new Map<string, string>();
  const renderPlaced = (blockName: string, m: ComposeModule): string => {
    const deferral = input.deferredModules?.[m.moduleId];
    // Nested modules rendered inside THIS placement when it is withheld.
    const gatedNestedIds = new Set<string>();
    const rendered = renderModuleFields(m, input);
    const baseHtml = rendered.html;
    recordFailures(moduleFailures, blockName, m, rendered.failures);
    for (const id of rendered.nestedModuleIds) {
      const nestedDeferral = input.deferredModules?.[id];
      if (nestedDeferral) {
        const nestedSlug = input.nestedModules?.getModule(id)?.slug ?? id;
        throw new ComposeError(
          "nested-module-deferred",
          `module "${nestedSlug}" is withheld by plugin "${nestedDeferral.pluginSlug}" (${nestedDeferral.reason}) but sits inside module "${m.slug}" in block "${blockName}", where it cannot be gated — ` +
            "place it on the page directly instead of inside another module's field",
          input.layoutSlug,
        );
      }
      // Inside a withheld parent the nested module is withheld too:
      // its CSS/JS go into the parent's <template>, never the page-wide
      // bundles, or its `fetch()` / `url(…)` would run before consent.
      if (deferral) {
        if (id !== m.moduleId) gatedNestedIds.add(id);
      } else {
        nestedAssetIds.push(id);
      }
    }
    const tagged = tagModuleId(baseHtml, m.moduleId);
    if (!deferral) return tagged;
    if (deferral.omit) {
      if (deferral.editorNotice) deferredCss.add(deferral.editorNotice.css);
      return omittedModuleNotice(m, deferral);
    }
    deferredCss.add(deferral.placeholderCss);
    const gatedNested = [...gatedNestedIds].map((id) => {
      const nested = input.nestedModules?.getModule(id);
      // renderModuleFields resolved every id it reports through this
      // same resolver; an unresolvable one here is a broken resolver.
      if (!nested) throw new Error(`nested module ${id} rendered but not resolvable`);
      return nested;
    });
    return wrapDeferredModule(tagged, m, gatedNested, deferral);
  };
  // A withheld module's CSS/JS travel inside its <template> (see
  // wrapDeferredModule); only modules that render normally feed the
  // page-wide bundles.
  const collectAssets = (m: ComposeModule): void => {
    if (seenAssetModules.has(m.moduleId)) return;
    seenAssetModules.add(m.moduleId);
    if (input.deferredModules?.[m.moduleId]) return;
    if (m.css.trim().length > 0) cssParts.push(m.css);
    if (m.js.trim().length > 0) jsParts.push(m.js);
  };
  // Nested modules' CSS/JS join the bundles right after the block whose
  // modules contain them, deduped with the placed modules (#158).
  const flushNestedAssets = (): void => {
    for (const id of nestedAssetIds.splice(0)) {
      if (seenAssetModules.has(id)) continue;
      seenAssetModules.add(id);
      const nested = input.nestedModules?.getModule(id);
      if (!nested) continue;
      if (nested.css.trim().length > 0) cssParts.push(nested.css);
      if (nested.js.trim().length > 0) jsParts.push(nested.js);
    }
  };
  for (const block of input.blocks) {
    const renderedModuleHtml = block.modules.map((m) => renderPlaced(block.blockName, m));
    templateContentByName.set(block.blockName, renderedModuleHtml.join("\n"));
    for (const m of block.modules) collectAssets(m);
    flushNestedAssets();
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
    const renderedModuleHtml = block.modules.map((m) => renderPlaced(block.blockName, m));
    layoutContentByName.set(block.blockName, renderedModuleHtml.join("\n"));
    for (const m of block.modules) collectAssets(m);
    flushNestedAssets();
  }

  for (const css of deferredCss) {
    if (css.trim().length > 0) cssParts.push(css);
  }

  // 3. Render the layout HTML, substituting all named slots. The
  //    layout's own markup (the page frame around the blocks) stores
  //    internal links as references too (#724 rollout C canonicalises
  //    layouts.create / .update), so they resolve here like module HTML
  //    — BEFORE the slots are filled, so already-resolved block HTML is
  //    not scanned twice. A failure lands in `missingSlots` (the
  //    preview's missing-content surface; the static build refuses it).
  const layoutLinkMarkers: string[] = [];
  const layoutHtml = resolveLinkRefsInHtml(input.layoutHtml, input.linkResolver, layoutLinkMarkers);
  const replaced = applySlotReplacements(layoutHtml, {
    contentByName: layoutContentByName,
  });
  let html = replaced.html;

  // issue #160 — every vetted interaction the page's markup asks for
  // (`data-caelo-ui="…"`, from modules, the layout or the template,
  // withheld modules included) ships once, after module
  // CSS/JS so its functional rules win over a module's display rules.
  const interactions = interactionAssets(new Set(findInteractionIds(html).known));
  cssParts.push(...interactions.css);
  jsParts.push(...interactions.js);

  // Theme brand metadata (favicon) — see composePagePreview.
  const themeHeadLinks = themeHeadFragment(input.theme);
  if (themeHeadLinks !== null) {
    html = injectBefore(html, HEAD_CLOSE_RE, themeHeadLinks);
  }

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
      `<style data-source="modules">\n${escapeStyleText(cssParts.join("\n"))}\n</style>`,
    );
  }
  if (jsParts.length > 0) {
    const joinedJs = jsParts.join("\n");
    const scriptTag = scriptNeedsEncoding(joinedJs)
      ? `<script defer data-source="modules" src="data:text/javascript;base64,${utf8ToBase64(joinedJs)}"></script>`
      : `<script defer data-source="modules">\n${joinedJs}\n</script>`;
    html = injectBefore(html, BODY_CLOSE_RE, scriptTag);
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
  for (const marker of layoutLinkMarkers) missingSet.add(marker);
  return {
    html,
    replacedSlots: [...replacedSet],
    missingSlots: [...missingSet],
    moduleFailures,
  };
}
