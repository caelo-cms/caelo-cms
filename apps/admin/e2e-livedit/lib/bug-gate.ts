// SPDX-License-Identifier: MPL-2.0
/**
 * Gates the e2e-livedit job on the bug reports the run filed. Run by the
 * workflow after the `ai_bug_reports` capture:
 *
 *   bun run apps/admin/e2e-livedit/lib/bug-gate.ts
 *
 * Each report is KNOWN (in the {@link KNOWN_BUGS} ledger) or NEW. Single new
 * reports no longer block (maintainer decision during the v0.11.0 cut: one
 * stray tool error per run held up a release for hours). The run forwards
 * every report to the Caelo bug intake (epic #901, CAELO_E2E_FORWARD_BUGS),
 * which files or joins the GitHub issue for it; this gate lists each new
 * report with that issue. Only more than {@link MAX_NEW_BUGS} new reports
 * fail the job: that many is a broken tool surface, not a stray error.
 *
 * A capture that failed (missing file or the `{}` sentinel) also fails the
 * gate — "could not check" must not read as "nothing found" (CLAUDE.md §2).
 */
import { existsSync, readFileSync } from "node:fs";
import { BUG_REPORTS_JSON, parseBugReports } from "./build-stats.js";
import { findKnownBug, KNOWN_BUGS, type KnownBug } from "./known-bugs.js";

/** New reports a run may file and still pass; one more fails it. */
export const MAX_NEW_BUGS = 5;

/** Outcome of gating one run's reports. */
export interface GateResult {
  ok: boolean;
  /** One line per finding, for the job log. */
  lines: string[];
  /** New reports that did not reach the bug intake (no issue for them). */
  unforwarded: number;
}

/**
 * Decide whether the run's bug reports pass the gate.
 *
 * @param raw contents of `bug-reports.json` ("" when the file is missing).
 */
export function gateBugReports(
  raw: string,
  ledger: readonly KnownBug[] = KNOWN_BUGS,
  maxNew: number = MAX_NEW_BUGS,
): GateResult {
  const reports = parseBugReports(raw);
  if (reports === null) {
    return {
      ok: false,
      unforwarded: 0,
      lines: [
        "bug-reports.json is missing or the ai_bug_reports capture failed — the run cannot be checked for detected bugs. See the 'Capture AI-detected bugs' step log.",
      ],
    };
  }
  const lines: string[] = [];
  let fresh = 0;
  let unforwarded = 0;
  for (const r of reports) {
    const known = findKnownBug(r, ledger);
    const where = r.suspectedTool ?? "no tool";
    if (known) {
      lines.push(`known (#${known.issue}) [${where}] ${r.title}`);
      continue;
    }
    fresh += 1;
    const sent = r.forwardingState === "sent";
    if (!sent) unforwarded += 1;
    const issue = r.upstreamIssueUrl
      ? ` → ${r.upstreamIssueUrl}`
      : sent
        ? " → sent to the bug intake (issue pending)"
        : ` → NOT forwarded (${r.forwardingState || "no state"}${r.forwardError ? `: ${r.forwardError.slice(0, 200)}` : ""})`;
    lines.push(
      `NEW [${where}] ${r.title}: ${r.whatHappened.replace(/\s+/g, " ").slice(0, 400)}${issue}`,
    );
  }
  const ok = fresh <= maxNew;
  if (fresh > 0) {
    lines.push(
      ok
        ? `${fresh} new detected bug(s), at most ${maxNew} allowed: not blocking; each is filed with the bug intake.`
        : `${fresh} new detected bugs — more than ${maxNew}: a broken tool surface. Fix the root causes in our layer (tool description, schema, op) before merging.`,
    );
  }
  return { ok, lines, unforwarded };
}

if (import.meta.main) {
  const raw = existsSync(BUG_REPORTS_JSON) ? readFileSync(BUG_REPORTS_JSON, "utf8") : "";
  const result = gateBugReports(raw);
  for (const line of result.lines) {
    if (!line.startsWith("NEW")) console.log(line);
    else if (!result.ok) console.log(`::error title=e2e-livedit new bug::${line}`);
    else console.log(`::warning title=e2e-livedit new bug::${line}`);
  }
  if (result.unforwarded > 0) {
    console.log(
      `::warning title=e2e-livedit bug forwarding::${result.unforwarded} new report(s) did not reach the bug intake, so no issue exists for them. Check the admin log ([bug-forwarding]) and file them by hand from the list above.`,
    );
  }
  process.exit(result.ok ? 0 : 1);
}
