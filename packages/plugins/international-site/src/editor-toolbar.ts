// SPDX-License-Identifier: MPL-2.0

/**
 * The plugin's place in the live editor's top bar (the SDK's
 * `editorToolbar`): which language the shown page is in, and how its other
 * language versions stand. The state is computed here, purely, from the
 * locale registry, the variant rows and the pages of the editor's chat
 * branch; `editor_languages` in ./index.ts only loads those.
 *
 * A language a page has no version in is not a problem: that URL is a
 * clean 404 by design (CMS_REQUIREMENTS §7.2), so it reads "Not
 * translated" without a tone. An out-of-date version is: it shows the
 * visitor old content, so it carries the attention tone and the count.
 */

import type { PluginEditorToolbarState } from "@caelo-cms/plugin-sdk";
import type { LocaleRow, PageVariantRow } from "./index.js";

/** One line of the toolbar popover. */
type ToolbarEntry = NonNullable<PluginEditorToolbarState["items"]>[number];

/** The fields of a page the toolbar state needs. */
export interface ToolbarPage {
  readonly id: string;
  readonly status: string;
}

const STATUS_DETAIL: Record<PageVariantRow["translation_status"], string> = {
  source: "Source",
  up_to_date: "Translated",
  needs_update: "Out of date",
};

/** The longest entry label the SDK's toolbar state accepts. */
const MAX_LABEL = 80;

/**
 * A language's name as an entry label: the configured name (up to 120
 * characters) shortened to the toolbar's limit, so one long name cannot
 * invalidate the whole state.
 */
function entryLabel(name: string): string {
  return name.length <= MAX_LABEL ? name : `${name.slice(0, MAX_LABEL - 1)}…`;
}

/** Upper-cased locale code, the label next to the icon. */
function codeLabel(code: string): string {
  return code.toUpperCase().slice(0, 8);
}

/**
 * The toolbar state for `pageId`. A page without a variant row is in the
 * default language and has no other versions yet.
 */
export function languageToolbarState(input: {
  readonly pageId: string;
  readonly locales: readonly LocaleRow[];
  readonly variants: readonly PageVariantRow[];
  readonly pages: ReadonlyMap<string, ToolbarPage>;
}): PluginEditorToolbarState {
  const { pageId, locales, variants, pages } = input;
  const defaultLocale = locales.find((l) => l.is_default);
  if (!defaultLocale) {
    return {
      tone: "attention",
      summary: "No languages are set up yet. Ask the AI to add the site's languages.",
    };
  }
  const own = variants.find((v) => v.page_id === pageId);
  const pageLocale = locales.find((l) => l.code === (own?.locale_code ?? defaultLocale.code));
  if (!pageLocale) {
    // A variant row naming a deleted locale: say so instead of guessing one.
    throw new Error(
      `international-site: page ${pageId} is marked as "${own?.locale_code}", which is not a set-up language. Link the page to an existing language or add that language.`,
    );
  }
  const group = own
    ? variants.filter((v) => v.group_id === own.group_id && pages.has(v.page_id))
    : [];
  const ordered = [pageLocale, ...locales.filter((l) => l.code !== pageLocale.code)];

  let outOfDate = 0;
  let translated = 0;
  const items = ordered.map((locale): ToolbarEntry => {
    const variant = group.find((v) => v.locale_code === locale.code);
    const isCurrent = locale.code === pageLocale.code;
    if (!variant && !isCurrent) {
      return { label: entryLabel(locale.display_name), detail: "Not translated" };
    }
    const status = variant?.translation_status ?? "source";
    if (status === "needs_update") outOfDate += 1;
    if (!isCurrent) translated += 1;
    const draft = variant && pages.get(variant.page_id)?.status === "draft";
    const detail = [isCurrent ? "This page" : null, STATUS_DETAIL[status], draft ? "draft" : null]
      .filter((p): p is string => p !== null)
      .join(" · ");
    return {
      label: entryLabel(locale.display_name),
      detail,
      ...(status === "needs_update" ? { tone: "attention" as const } : {}),
      ...(isCurrent ? { current: true } : { pageId: (variant as PageVariantRow).page_id }),
    };
  });

  const others = locales.length - 1;
  const ownStale = own?.translation_status === "needs_update";
  const where = `This page is in ${pageLocale.display_name}${ownStale ? " and out of date with its source" : ""}.`;
  const otherStale = outOfDate - (ownStale ? 1 : 0);
  const summary =
    others === 0
      ? `This page is in ${pageLocale.display_name}, the site's only language.`
      : `${where} ${translated} of ${others} other ${others === 1 ? "language has" : "languages have"} a version${otherStale > 0 ? `, ${otherStale} out of date` : ""}.`;

  return {
    label: codeLabel(pageLocale.code),
    ...(outOfDate > 0 ? { count: outOfDate, tone: "attention" as const } : {}),
    summary,
    items: capItems(items),
  };
}

/** The most entries the SDK's toolbar state accepts. */
const MAX_ITEMS = 20;

/**
 * Keeps the popover within {@link MAX_ITEMS} on a site with more languages:
 * the shown page first, then the out-of-date versions (they need work),
 * then the other versions, then the missing ones; what does not fit is
 * one closing line. The count and summary still cover every language.
 */
function capItems(items: ToolbarEntry[]): ToolbarEntry[] {
  if (items.length <= MAX_ITEMS) return items;
  const rank = (i: ToolbarEntry): number =>
    i.current ? 0 : i.tone === "attention" ? 1 : i.pageId !== undefined ? 2 : 3;
  const sorted = [...items].sort((a, b) => rank(a) - rank(b));
  const shown = sorted.slice(0, MAX_ITEMS - 1);
  const rest = items.length - shown.length;
  return [...shown, { label: `${rest} more languages`, detail: "Ask the AI for the full status" }];
}
