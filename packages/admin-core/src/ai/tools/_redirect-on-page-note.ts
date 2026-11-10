// SPDX-License-Identifier: MPL-2.0

/**
 * #1447 — what a write tool says when its write leaves a redirect rule on a
 * page's URL. The rule never beats a page a build serves (the redirect plan
 * leaves it out on every provider), so this is not "the page is shadowed":
 * the rule keeps answering until a build carries the page, then does nothing,
 * and comes back when the page leaves the build. Which of the two should own
 * the URL is the writer's call, so the tool asks at once instead of leaving
 * it to the next Stage (`links/redirect-shadows-page`).
 *
 * #1517 — a page that was never live takes its URL over at the Publish live
 * that first ships it, so for one the note says so and warns against
 * deleting the rule early: the rule is live state, and deleting it now would
 * leave the live URL answering 404 until that Publish live.
 *
 * #1550 — a rule that is not live yet (a Staged or Draft change) is named
 * with its state, and the warning against an early delete is for a live
 * rule only.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { RedirectPageConflict } from "../../ops/content/redirect-page-conflicts.js";
import { describeError } from "./_describe-error.js";
import type { ToolContext } from "./dispatch.js";

/** How many conflicts to name before summarising. */
const CONFLICTS_SHOWN = 5;

/** What was written: pages, or the from paths of new rules. */
export type RedirectConflictLookup =
  | { readonly pageIds: readonly string[] }
  | { readonly paths: readonly string[] };

/**
 * The note for `lookup`, with a leading newline, or "" when no rule sits on a
 * page's URL. A failed read says so: it must not pass for "no conflict".
 */
export async function redirectOnPageNote(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  lookup: RedirectConflictLookup,
): Promise<string> {
  const r = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    ctx,
    "redirects.page_conflicts",
    lookup,
  );
  if (!r.ok) return `\nRedirects on these URLs unknown: ${describeError(r.error)}`;
  const { conflicts } = r.value as { conflicts: RedirectPageConflict[] };
  if (conflicts.length === 0) return "";
  return `\n${"paths" in lookup ? describeRulesOnPages(conflicts) : describePagesOnRules(conflicts)}`;
}

/**
 * #1517, #1550 — rules on the URLs of pages that were never live: the
 * Publish live that first ships a page takes its URL over. A live rule must
 * not be deleted before then (`liveTail`); a pending one is not live yet.
 */
function describeNewPages(
  fresh: readonly RedirectPageConflict[],
  tail: string,
  liveTail: string,
): string[] {
  const was = (c: readonly RedirectPageConflict[]) => (c.length === 1 ? "was" : "were");
  const live = fresh.filter((c) => c.ruleState === "live");
  const pending = fresh.filter((c) => c.ruleState !== "live");
  return [
    live.length > 0
      ? `A redirect rule sits on the URL of ${pagesOf(live)}, which ${was(live)} never live: ${rulesOf(live)}. ${NEW_PAGE_TAKES_OVER} ${tail}${liveTail}`
      : "",
    pending.length > 0
      ? `A redirect rule sits on the URL of ${pagesOf(pending)}, which ${was(pending)} never live: ${rulesOf(pending)}. ${NEW_PAGE_TAKES_OVER_PENDING} ${tail}`
      : "",
  ];
}

/** The note after a page write. */
function describePagesOnRules(conflicts: readonly RedirectPageConflict[]): string {
  const fresh = conflicts.filter((c) => !c.pageLive);
  const live = conflicts.filter((c) => c.pageLive);
  return [
    ...describeNewPages(
      fresh,
      "If the rule should keep the URL, give the page another slug (update_pages_many).",
      " Do not delete the rule before then: the live site would answer 404 at that URL until Publish live.",
    ),
    live.length > 0
      ? `A redirect rule sits on the URL of ${pagesOf(live)}: ${rulesOf(live)}. ` +
        "The rule answers that URL until a build ships the page, so the page looks unreachable until then: a draft needs set_pages_status_many first, then a Stage for staging and Publish live for the live site. Once a build serves the page, the page wins and the rule does nothing; Stage reports the pair as an error. " +
        `Next step: if the page stays at this URL, ${deleteCall(live)}; if the rule should keep the URL, give the page another slug (update_pages_many).`
      : "",
  ]
    .filter((t) => t !== "")
    .join("\n");
}

/** The note after a redirect write. */
function describeRulesOnPages(conflicts: readonly RedirectPageConflict[]): string {
  const fresh = conflicts.filter((c) => !c.pageLive);
  const live = conflicts.filter((c) => c.pageLive);
  return [
    ...describeNewPages(
      fresh,
      "If the URL should keep redirecting, set the page to draft (set_pages_status_many) or move it (move_pages).",
      "",
    ),
    live.length > 0
      ? `A redirect rule sits on the URL of ${pagesOf(live)}: ${rulesOf(live)}. ` +
        "A page wins over a rule: once a build serves the page, the rule does nothing, and Stage reports the pair as an error. " +
        `Next step: if the page stays, ${deleteCall(live)}; if the URL should redirect, set the page to draft (set_pages_status_many) or move it (move_pages).`
      : "",
  ]
    .filter((t) => t !== "")
    .join("\n");
}

/** #1517 — what happens to a live rule on the URL of a page that was never live. */
const NEW_PAGE_TAKES_OVER =
  "The rule keeps answering that URL on the live site until the page is published and Publish live ships it; that Publish live deletes the rule, so the page takes its URL over with nothing to do.";

/** #1550 — the same for a rule that is not live yet (Staged or Draft). */
const NEW_PAGE_TAKES_OVER_PENDING =
  "The rule is not live yet; the Publish live that first ships the page deletes it, so the page takes its URL over with nothing to do.";

function pagesOf(conflicts: readonly RedirectPageConflict[]): string {
  const shown = conflicts
    .slice(0, CONFLICTS_SHOWN)
    .map((c) => `"${c.pageTitle}" (${c.pagePath}, ${c.pageStatus})`);
  return `${conflicts.length === 1 ? "page" : "pages"} ${shown.join(", ")}${more(conflicts)}`;
}

function rulesOf(conflicts: readonly RedirectPageConflict[]): string {
  // #1550 — a pending rule says so: it is not on the live site yet.
  const state = (c: RedirectPageConflict) =>
    c.ruleState === "live" ? "" : c.ruleState === "staged" ? ", Staged" : ", Draft";
  return `${conflicts
    .slice(0, CONFLICTS_SHOWN)
    .map((c) => `${c.fromPath} -> ${c.toPath} (${c.statusCode}${state(c)})`)
    .join(", ")}${more(conflicts)}`;
}

function more(conflicts: readonly RedirectPageConflict[]): string {
  return conflicts.length > CONFLICTS_SHOWN ? `, … (${conflicts.length} in all)` : "";
}

function deleteCall(conflicts: readonly RedirectPageConflict[]): string {
  const fromPaths = [...new Set(conflicts.map((c) => c.fromPath))];
  return `remove the rule with bulk_delete_redirects({ fromPaths: ${JSON.stringify(fromPaths)} })`;
}
