// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — how `get_quality_audit` shows the page checks' findings to
 * the AI: each blocking rule with its count, the first messages, and the
 * fix hint (tool + what to do), so the AI can fix without another read;
 * then the non-blocking warnings / hints, bounded.
 */

import type { CheckRuleProblem } from "../../quality/checks/evaluate.js";
import type { Finding } from "../../quality/checks/findings.js";
import type { RunChecksSummary } from "../../quality/checks/outcome.js";

/** Non-blocking findings shown per page / site before "… and N more". */
const NOTE_LIMIT = 8;

/**
 * Lines of one page-check problem. `accepted`: a live editor acceptance
 * covers it now (#727: accepted findings stay visible, but do not block).
 */
export function formatCheckProblem(problem: CheckRuleProblem, accepted = false): string[] {
  const lines = [
    accepted
      ? `- ACCEPTED by an editor (does not block; leave it unless asked) page check \`${problem.ruleId}\` — ${problem.count} error(s)`
      : `- PROBLEM page check \`${problem.ruleId}\` — ${problem.count} error(s)`,
  ];
  const fixes = new Set<string>();
  for (const f of problem.findings) {
    lines.push(`  - ${f.message}`);
    if (f.fix) fixes.add(`  fix: \`${f.fix.tool}\` — ${f.fix.hint}`);
  }
  if (problem.count > problem.findings.length) {
    lines.push(`  - … and ${problem.count - problem.findings.length} more of this rule`);
  }
  lines.push(...fixes);
  return lines;
}

/** Warnings and hints (never blocking), bounded. */
export function formatCheckNotes(findings: readonly Finding[]): string[] {
  const notes = findings.filter((f) => f.severity !== "error");
  const lines = notes
    .slice(0, NOTE_LIMIT)
    .map(
      (f) =>
        `- ${f.severity === "warning" ? "warning" : "hint"} \`${f.ruleId}\` (does not block) — ${f.message}${f.fix ? ` Fix: \`${f.fix.tool}\` — ${f.fix.hint}` : ""}`,
    );
  if (notes.length > NOTE_LIMIT) {
    lines.push(`- … and ${notes.length - NOTE_LIMIT} more warning(s)/hint(s)`);
  }
  return lines;
}

/**
 * The run-level block: what the page checks read, site-wide findings,
 * errors. `siteAccepted[i]`: a live acceptance covers `siteProblems[i]`.
 */
export function formatChecksSummary(
  checks: RunChecksSummary,
  siteAccepted: readonly boolean[] = [],
): string[] {
  const c = checks.findingCounts;
  const lines = [
    `page checks (every page, every Stage): ${checks.ran.map((r) => r.id).join(", ") || "none"} — ${checks.pagesChecked} page(s) read; ${c.error} error(s), ${c.warning} warning(s), ${c.info} hint(s)`,
  ];
  for (const e of checks.errors) {
    lines.push(`- CHECK FAILED${e.checkId ? ` (${e.checkId})` : ""}: ${e.message}`);
  }
  if (checks.siteProblems.length > 0 || checks.siteFindings.some((f) => f.severity !== "error")) {
    lines.push("", "## site-wide (accept with ruleId and no pagePath)");
    for (const [i, p] of checks.siteProblems.entries()) {
      lines.push(...formatCheckProblem(p, siteAccepted[i] === true));
    }
    lines.push(...formatCheckNotes(checks.siteFindings));
  }
  return lines;
}
