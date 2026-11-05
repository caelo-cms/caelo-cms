// SPDX-License-Identifier: MPL-2.0

/**
 * #1447 — what a write tool says when its write leaves a redirect rule on a
 * page's URL. The rule never beats a page a build serves (the redirect plan
 * leaves it out on every provider), so this is not "the page is shadowed":
 * the rule keeps answering until a build carries the page, then does nothing,
 * and comes back when the page leaves the build. Which of the two should own
 * the URL is the writer's call, so the tool asks at once instead of leaving
 * it to the next Stage (`links/redirect-shadows-page`).
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

/** The note after a page write. */
function describePagesOnRules(conflicts: readonly RedirectPageConflict[]): string {
  return (
    `A redirect rule sits on the URL of ${pagesOf(conflicts)}: ${rulesOf(conflicts)}. ` +
    "The rule answers that URL until a build ships the page, so the page looks unreachable until then: a draft needs set_pages_status_many first, then a Stage for staging and Publish live for the live site. Once a build serves the page, the page wins and the rule does nothing; Stage reports the pair as an error. " +
    `Next step: if the page stays at this URL, ${deleteCall(conflicts)}; if the rule should keep the URL, give the page another slug (update_pages_many).`
  );
}

/** The note after a redirect write. */
function describeRulesOnPages(conflicts: readonly RedirectPageConflict[]): string {
  return (
    `A redirect rule sits on the URL of ${pagesOf(conflicts)}: ${rulesOf(conflicts)}. ` +
    "A page wins over a rule: once a build serves the page, the rule does nothing, and Stage reports the pair as an error. " +
    `Next step: if the page stays, ${deleteCall(conflicts)}; if the URL should redirect, set the page to draft (set_pages_status_many) or move it (move_pages).`
  );
}

function pagesOf(conflicts: readonly RedirectPageConflict[]): string {
  const shown = conflicts
    .slice(0, CONFLICTS_SHOWN)
    .map((c) => `"${c.pageTitle}" (${c.pagePath}, ${c.pageStatus})`);
  return `${conflicts.length === 1 ? "page" : "pages"} ${shown.join(", ")}${more(conflicts)}`;
}

function rulesOf(conflicts: readonly RedirectPageConflict[]): string {
  return `${conflicts
    .slice(0, CONFLICTS_SHOWN)
    .map((c) => `${c.fromPath} -> ${c.toPath} (${c.statusCode})`)
    .join(", ")}${more(conflicts)}`;
}

function more(conflicts: readonly RedirectPageConflict[]): string {
  return conflicts.length > CONFLICTS_SHOWN ? `, … (${conflicts.length} in all)` : "";
}

function deleteCall(conflicts: readonly RedirectPageConflict[]): string {
  const fromPaths = [...new Set(conflicts.map((c) => c.fromPath))];
  return `remove the rule with bulk_delete_redirects({ fromPaths: ${JSON.stringify(fromPaths)} })`;
}
