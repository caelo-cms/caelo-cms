// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout F) — the core `references` check: reference
 * integrity at Publish live / promote to production.
 *
 * Every Stage's audit runs it over the main line (what the staged build
 * was rendered from) with the PUBLISH policy (maintainer decision on
 * #724): a link to a deleted page, to a page without a version in the
 * linking page's language, or to an unpublished page is an `error` — it
 * blocks Publish live until fixed or accepted by the Owner (the gate's
 * per-rule acceptances, gate.ts). Legacy literal paths are warnings.
 *
 * Split with the staged-build `links` check (#849), so one defect is one
 * finding:
 *   - `links` reads what SHIPS (rendered URLs) and owns URLs that no page
 *     or file answers — a broken legacy literal path included;
 *   - `references` reads where the link is STORED and owns stored
 *     references: missing, language-less and unpublished targets. A
 *     rendered link to a draft page is skipped by `links` for that reason.
 *
 * Rules:
 *   - `references/missing-target`      (error)
 *   - `references/variant-missing`     (error)
 *   - `references/unpublished-target`  (error)
 *   - `references/missing-list`        (error) — a bound shared list was deleted (epic #1107)
 *   - `references/missing-term`        (error) — a page term / query term whose entry is gone
 *   - `references/missing-module`      (error) — a list entry embeds a deleted module
 *   - `references/literal-link`        (warning) — converted by the link migration
 *   - `references/limit-reached`       (info)
 */

import { truncateKeepingIds } from "@caelo-cms/shared";
import type { SiteCheck } from "./check.js";
import type { Finding } from "./findings.js";
import { MAX_FINDINGS_PER_CALL } from "./runner.js";

export const REFERENCES_CHECK_ID = "references";

/** One issue as `links.check_references` returns it. */
export interface ReferenceCheckIssue {
  readonly problem: string;
  readonly severity: "block" | "warning";
  readonly place: { readonly kind: string };
  readonly pageIds: readonly string[];
  readonly message: string;
  readonly fix: { readonly tool: string; readonly hint: string };
}

/** Where the check reads the issues (main line, Publish policy). */
export interface ReferenceSources {
  issues(limit: number): Promise<{
    readonly issues: readonly ReferenceCheckIssue[];
    readonly truncated: boolean;
  }>;
}

/** Build the core references check over the given source. */
export function createReferencesCheck(sources: ReferenceSources): SiteCheck {
  return {
    id: REFERENCES_CHECK_ID,
    title: "Internal link references",
    scope: "site",
    async run({ pages }) {
      const r = await sources.issues(MAX_FINDINGS_PER_CALL - 1);
      return referenceFindings(r.issues, r.truncated, new Set(pages.map((p) => p.pageId)));
    },
  };
}

/**
 * Map issues to findings. Exported for tests.
 *
 * @param stagedPageIds the pages of the staged build (published only). A
 *   finding may name only one of them — the runner rejects the whole check
 *   otherwise — so an issue stored on a draft page stays site-scoped.
 */
export function referenceFindings(
  issues: readonly ReferenceCheckIssue[],
  truncated: boolean,
  stagedPageIds: ReadonlySet<string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const i of issues) {
    // A literal that matches nothing (a pending import link included) is the
    // staged-build check's finding: it is a URL the build does not serve.
    if (i.problem === "broken-literal" || i.problem === "pending-import-link") continue;
    // Page-bound content belongs to its page (acceptance per page); a place
    // shared by several pages, or site-wide chrome, is one site finding. A
    // draft page is not in the staged build, so its issue (a warning — it
    // does not ship) is a site finding too: the message names the page.
    const pageBound = i.place.kind === "content" || i.place.kind === "page";
    const only = pageBound && i.pageIds.length === 1 ? i.pageIds[0] : undefined;
    const pageId = only !== undefined && stagedPageIds.has(only) ? only : undefined;
    findings.push({
      ruleId: `${REFERENCES_CHECK_ID}/${i.problem}`,
      severity: i.severity === "block" ? "error" : "warning",
      ...(pageId ? { pageId } : {}),
      message: truncateKeepingIds(i.message, 1000),
      fix: { tool: i.fix.tool, hint: i.fix.hint },
    });
  }
  if (truncated) {
    findings.push({
      ruleId: `${REFERENCES_CHECK_ID}/limit-reached`,
      severity: "info",
      message: `More link problems: the list was cut at ${MAX_FINDINGS_PER_CALL - 1}. Fix the listed ones (check_links lists all) and Stage again to see the rest.`,
    });
  }
  return findings;
}
