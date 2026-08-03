// SPDX-License-Identifier: MPL-2.0

/**
 * issue #375 — theme shell for growth-time design-draft previews.
 *
 * Page/module-scope drafts are stored as FRAGMENTS bound to the site's
 * `var(--…)` tokens; this composer wraps one in the site's real
 * compiled theme at view time: web fonts (#150), theme CSS variables,
 * and the invisible technical baseline (#151) — in the exact head
 * order `composePagePreview` uses, so a draft previews in the same
 * cascade it will materialise into. Pure / sync / no IO: the caller
 * (the `genesis.render_draft` op) loads the theme row and resolves
 * fonts, mirroring `pages.render_preview`.
 */

import { BASE_TECHNICAL_CSS } from "./base-css.js";
import { type ComposeFonts, type ComposeTheme, fontsHeadFragment } from "./preview-compose.js";
import { caeloMissingComment } from "./template-engine.js";
import { renderThemeCss } from "./theme-render.js";

/** Same four placeholders the template engine resolves (v0.11.1, #76). */
const THEME_ASSET_KEY_TO_SLOT = {
  theme_logo_url: "logo",
  theme_logo_dark_url: "logoDark",
  theme_favicon_url: "favicon",
  theme_social_share_url: "socialShare",
} as const;

export interface DesignDraftShellInput {
  /** The stored fragment (already script-stripped at the boundary). */
  readonly fragmentHtml: string;
  /** Active theme; undefined renders the shell without theme vars
   *  (loud: the draft's `var(--…)` references fall to browser initial
   *  values — visibly broken, per CLAUDE.md §2 no-fallbacks). */
  readonly theme?: ComposeTheme;
  /** Resolved web fonts; undefined = system stacks only. */
  readonly fonts?: ComposeFonts;
  /** Document title shown in the iframe (accessibility). */
  readonly title: string;
}

export interface DesignDraftShellOutput {
  readonly html: string;
  /** `theme-asset-unbound:<slot>` markers, mirroring the template
   *  engine's failure-marker contract. */
  readonly missingSlots: readonly string[];
}

/**
 * Resolve `{{theme_*_url}}` placeholders in a draft fragment. Bound
 * slots substitute their URL; a placeholder on an unbound slot stays
 * loud-raw and lands in `missingSlots` — the same contract module HTML
 * gets from the template engine. Other `{{…}}` sequences are left
 * untouched: a draft is not a fielded module.
 */
function substituteThemeAssetUrls(
  html: string,
  theme: ComposeTheme | undefined,
  missing: string[],
): string {
  return html.replace(/\{\{\s*(theme_[a-z_]+)\s*\}\}/g, (match, key: string) => {
    const slot = THEME_ASSET_KEY_TO_SLOT[key as keyof typeof THEME_ASSET_KEY_TO_SLOT];
    if (slot === undefined) return match;
    const url = theme?.assets[slot]?.url;
    if (url === undefined) {
      missing.push(`theme-asset-unbound:${slot}`);
      return match + caeloMissingComment(`theme-asset-unbound:${slot}`);
    }
    return url;
  });
}

export function composeDesignDraftShell(input: DesignDraftShellInput): DesignDraftShellOutput {
  const missing: string[] = [];
  const body = substituteThemeAssetUrls(input.fragmentHtml, input.theme, missing);

  // Head order mirrors composePagePreview: fonts first (URL discovery),
  // then theme vars (so fragment CSS can `var(--color-primary)`), then
  // the technical baseline.
  const head: string[] = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(input.title)}</title>`,
  ];
  const fonts = fontsHeadFragment(input.fonts);
  if (fonts !== null) head.push(fonts);
  const themeCss = input.theme !== undefined ? renderThemeCss(input.theme.tokens) : null;
  if (themeCss !== null) head.push(`<style data-source="theme">${themeCss}</style>`);
  head.push(`<style data-source="base">${BASE_TECHNICAL_CSS}</style>`);

  return {
    html: `<!doctype html>\n<html><head>${head.join("")}</head><body>${body}</body></html>`,
    missingSlots: missing,
  };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
