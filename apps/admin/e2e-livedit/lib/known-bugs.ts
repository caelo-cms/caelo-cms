// SPDX-License-Identifier: MPL-2.0
/**
 * Detected-bug triage ledger for the real-AI suite.
 *
 * Every `ai_bug_reports` row a run files is either KNOWN (it matches an entry
 * here, which points at the GitHub issue tracking its root-cause fix) or NEW.
 * A new one fails the e2e-livedit job (`bug-gate.ts`): a tool error the AI had
 * to recover from is our defect (CLAUDE.md §1A/§4), and a non-blocking report
 * is exactly what used to pile up unowned under every PR.
 *
 * Adding an entry is a deliberate act: open the issue first, then list it here
 * with the narrowest `match` that identifies the root cause. Remove the entry
 * in the PR that fixes the issue — a stale entry would hide a regression.
 */

/** The fields of an `ai_bug_reports` row the matcher reads. */
export interface BugSignature {
  suspectedTool: string | null;
  title: string;
  whatHappened: string;
}

/** One triaged root cause. */
export interface KnownBug {
  /** GitHub issue number tracking the fix. */
  issue: number;
  /** Exact `suspected_tool` value, or null to match any tool. */
  tool: string | null;
  /** Tested against `title` and `whatHappened`. */
  match: RegExp;
}

/** Currently triaged-but-unfixed root causes. Empty means every report is new. */
export const KNOWN_BUGS: readonly KnownBug[] = [
  // edit_content anchor wrapped in literal quotes reported as a stale body.
  { issue: 1084, tool: "edit_content", match: /^oldString not found\. It may be stale/ },
];

/**
 * Find the ledger entry a report belongs to.
 *
 * @returns the entry, or undefined when the report is new.
 */
export function findKnownBug(
  report: BugSignature,
  ledger: readonly KnownBug[] = KNOWN_BUGS,
): KnownBug | undefined {
  return ledger.find(
    (k) =>
      (k.tool === null || k.tool === report.suspectedTool) &&
      (k.match.test(report.title) || k.match.test(report.whatHappened)),
  );
}
