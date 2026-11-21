// SPDX-License-Identifier: MPL-2.0

/**
 * What counts for the site search (issue #1651): the plugin's rules over
 * a page's output facts. Pure functions; the observer feeds them.
 *
 * | Where and what                                   | Counts                               |
 * |--------------------------------------------------|--------------------------------------|
 * | module on up to `fullMax` pages                  | fully, on each                       |
 * | module on up to `reducedMax` pages               | reduced, on each                     |
 * | module on more, or on more than half (from 11)   | only on its home page (else not)     |
 * | header, navigation, footer (layout chrome)       | text only on its home page; links    |
 * |                                                  | describe their targets (anchor text) |
 * | form fields, labels and buttons                  | never                                |
 * | template blocks (the page's own values)          | always                               |
 * | plugin regions, noindex, 404, results page,      | never (the page is not a result)     |
 * | excluded pages                                   |                                      |
 *
 * An explicit mode on the content instance, then on the module, wins over
 * the automatic rule. The thresholds are placement steps the host knows
 * (`pageOutputObserver.placementSteps`), so a module crossing one makes the
 * same Stage deliver every page it is on again.
 */

import { type PageOutputFacts, type PageOutputModule, placementStep } from "@caelo-cms/plugin-sdk";

/** The half-of-all-pages rule applies from this many placements on. */
export const HALF_RULE_FROM = 11;

export type SearchMode = "auto" | "full" | "reduced" | "home" | "never";

/** How a module's text counts on one page. */
export type Weighting = "full" | "reduced" | "none";

export interface CountingSettings {
  readonly fullMax: number;
  readonly reducedMax: number;
  readonly chromeLinks: boolean;
}

export interface ModuleSettings {
  readonly mode: SearchMode;
  readonly homePage: string | null;
}

/** Why a module counts as it does, for the index report. */
export type WeightingReason =
  | "own"
  | "few-pages"
  | "many-pages"
  | "home-page"
  | "not-home-page"
  | "no-home-page"
  | "chrome"
  | "explicit"
  | "template";

export interface ModuleVerdict {
  readonly weighting: Weighting;
  readonly reason: WeightingReason;
}

/** How module `m` counts on page `pageId`. */
export function moduleWeighting(
  m: PageOutputModule,
  pageId: string,
  publishedPages: number,
  counting: CountingSettings,
  moduleSettings: ModuleSettings | undefined,
  instanceMode: SearchMode | undefined,
): ModuleVerdict {
  const homePage = moduleSettings?.homePage ?? null;
  const explicit =
    instanceMode && instanceMode !== "auto" ? instanceMode : (moduleSettings?.mode ?? "auto");
  if (explicit !== "auto") {
    if (explicit === "home")
      return homePage === pageId
        ? { weighting: "full", reason: "home-page" }
        : { weighting: "none", reason: homePage ? "not-home-page" : "no-home-page" };
    return { weighting: explicit === "never" ? "none" : explicit, reason: "explicit" };
  }
  if (m.zone === "layout") {
    return homePage === pageId
      ? { weighting: "full", reason: "home-page" }
      : { weighting: "none", reason: "chrome" };
  }
  if (m.zone === "template") return { weighting: "full", reason: "template" };
  // What repeats is the content, not the design: a text module with each
  // page's own words counts on each page.
  const step = placementStep(
    m.contentPlacementCount,
    publishedPages,
    [counting.fullMax, counting.reducedMax],
    HALF_RULE_FROM,
  );
  if (step === 0)
    return { weighting: "full", reason: m.contentPlacementCount <= 1 ? "own" : "few-pages" };
  if (step === 1) return { weighting: "reduced", reason: "few-pages" };
  if (homePage === pageId) return { weighting: "full", reason: "home-page" };
  return { weighting: "none", reason: homePage ? "not-home-page" : "no-home-page" };
}

/** Why a page is not a result, or null when it is one. */
export function pageExclusion(
  facts: PageOutputFacts,
  opts: { readonly resultsPage: string | null; readonly excluded: boolean },
): "noindex" | "not-found-page" | "results-page" | "excluded" | null {
  if (facts.notFoundPage) return "not-found-page";
  if (opts.resultsPage === facts.pageId) return "results-page";
  if (opts.excluded) return "excluded";
  if (facts.noindex) return "noindex";
  return null;
}

/** Text sources that count: visible text, code and image descriptions. */
const COUNTED_SOURCES = new Set(["text", "literal", "alt"]);

/** Whether one text run can count at all (before its module's weighting). */
export function textMayCount(t: PageOutputFacts["texts"][number]): boolean {
  return (
    t.pluginSlug === null &&
    !t.inForm &&
    t.moduleId !== null &&
    COUNTED_SOURCES.has(t.source) &&
    t.text.trim().length > 0
  );
}
