// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — the open problems of an audit grouped by rule across pages,
 * so the operator decides per group instead of per page: "seo-check/
 * description-missing: 312 pages — fix all / accept all / pick pages".
 * Pure; the chat card, the fix prompt and the bulk acceptance share it.
 *
 * A group's key names what failed, independent of the page:
 * - a page-check rule: its rule id (`seo-check/description-missing`);
 * - a failing Lighthouse audit: `lighthouse/<category>/<audit id>`, with
 *   the first gated category that references it;
 * - a category below 100: `lighthouse/<category>/score`.
 * `ref` is the same thing in the shape `accept_quality_findings` takes.
 */

import { findingLabel } from "./checks/findings.js";
import type { OpenProblem } from "./gate.js";
import type { QualityCategory, QualityProblem } from "./ratchet.js";

/** What a group accepts, in the shape of an acceptance item. */
export type ProblemRef =
  | { readonly auditId: string }
  | { readonly category: QualityCategory }
  | { readonly ruleId: string };

/** One page (or "site-wide", pageId null) a group's problem is open on. */
export interface ProblemGroupPage {
  readonly pageId: string | null;
  readonly pagePath: string;
  /** The page's measured value, for the operator ("score 87", "3×"). */
  readonly detail: string;
}

export interface ProblemGroup {
  readonly key: string;
  readonly ref: ProblemRef;
  /** Operator-readable name of what failed. */
  readonly title: string;
  readonly pages: ProblemGroupPage[];
}

/** The group key and ref of one problem. */
export function problemGroupKey(problem: QualityProblem): { key: string; ref: ProblemRef } {
  switch (problem.kind) {
    case "check_rule":
      return { key: problem.ruleId, ref: { ruleId: problem.ruleId } };
    case "failing_audit":
      return {
        key: `lighthouse/${problem.categories[0] ?? "audit"}/${problem.auditId}`,
        ref: { auditId: problem.auditId },
      };
    case "score_below_baseline":
      return { key: `lighthouse/${problem.category}/score`, ref: { category: problem.category } };
  }
}

const CATEGORY_LABEL: Record<QualityCategory, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  "best-practices": "Best Practices",
  seo: "SEO",
};

function titleOf(problem: QualityProblem): string {
  switch (problem.kind) {
    case "check_rule":
      return problem.findings[0] ? findingLabel(problem.findings[0].message) : problem.ruleId;
    case "failing_audit":
      return problem.title;
    case "score_below_baseline":
      return `${CATEGORY_LABEL[problem.category]} score below 100`;
  }
}

function detailOf(problem: QualityProblem): string {
  switch (problem.kind) {
    case "check_rule":
      return `${problem.count}×`;
    case "failing_audit":
      return problem.displayValue ?? `score ${Math.round(problem.score * 100)}`;
    case "score_below_baseline":
      return `score ${problem.score}`;
  }
}

/**
 * Group open problems by rule across pages. Biggest groups first, then by
 * key; pages keep the order they came in (homepage first).
 */
export function groupOpenProblems(open: readonly OpenProblem[]): ProblemGroup[] {
  const groups = new Map<
    string,
    { key: string; ref: ProblemRef; title: string; pages: ProblemGroupPage[] }
  >();
  for (const o of open) {
    const { key, ref } = problemGroupKey(o.problem);
    let g = groups.get(key);
    if (!g) {
      g = { key, ref, title: titleOf(o.problem), pages: [] };
      groups.set(key, g);
    }
    g.pages.push({ pageId: o.pageId, pagePath: o.pagePath, detail: detailOf(o.problem) });
  }
  return [...groups.values()].sort(
    (a, b) => b.pages.length - a.pages.length || a.key.localeCompare(b.key),
  );
}

/** "seo-check/description-missing: 312 page(s)" — one line per group. */
export function groupSummaryLine(group: ProblemGroup, samplePaths = 3): string {
  const shown = group.pages.slice(0, samplePaths).map((p) => p.pagePath);
  const more = group.pages.length > samplePaths ? `, +${group.pages.length - samplePaths}` : "";
  return `${group.key} — ${group.title}: ${group.pages.length} page(s) (${shown.join(", ")}${more})`;
}
