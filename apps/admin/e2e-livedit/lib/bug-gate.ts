// SPDX-License-Identifier: MPL-2.0
/**
 * Fails the e2e-livedit job when the run filed a bug report that is not in the
 * {@link KNOWN_BUGS} ledger. Run by the workflow after the
 * `ai_bug_reports` capture:
 *
 *   bun run apps/admin/e2e-livedit/lib/bug-gate.ts
 *
 * A capture that failed (missing file or the `{}` sentinel) also fails the
 * gate — "could not check" must not read as "nothing found" (CLAUDE.md §2).
 */
import { existsSync, readFileSync } from "node:fs";
import { BUG_REPORTS_JSON, parseBugReports } from "./build-stats.js";
import { type BugSignature, findKnownBug, type KnownBug, KNOWN_BUGS } from "./known-bugs.js";

/** Outcome of gating one run's reports. */
export interface GateResult {
  ok: boolean;
  /** One line per finding, for the job log. */
  lines: string[];
}

/**
 * Decide whether the run's bug reports pass the gate.
 *
 * @param raw contents of `bug-reports.json` ("" when the file is missing).
 */
export function gateBugReports(raw: string, ledger: readonly KnownBug[] = KNOWN_BUGS): GateResult {
  const reports: BugSignature[] | null = parseBugReports(raw);
  if (reports === null) {
    return {
      ok: false,
      lines: [
        "bug-reports.json is missing or the ai_bug_reports capture failed — the run cannot be checked for detected bugs. See the 'Capture AI-detected bugs' step log.",
      ],
    };
  }
  const lines: string[] = [];
  let fresh = 0;
  for (const r of reports) {
    const known = findKnownBug(r, ledger);
    const where = r.suspectedTool ?? "no tool";
    if (known) {
      lines.push(`known (#${known.issue}) [${where}] ${r.title}`);
    } else {
      fresh += 1;
      lines.push(`NEW [${where}] ${r.title}: ${r.whatHappened.replace(/\s+/g, " ").slice(0, 400)}`);
    }
  }
  if (fresh > 0) {
    lines.push(
      `${fresh} new detected bug(s). Fix the root cause in our layer (tool description, schema, op), or open an issue and add it to apps/admin/e2e-livedit/lib/known-bugs.ts.`,
    );
  }
  return { ok: fresh === 0, lines };
}

if (import.meta.main) {
  const raw = existsSync(BUG_REPORTS_JSON) ? readFileSync(BUG_REPORTS_JSON, "utf8") : "";
  const result = gateBugReports(raw);
  for (const line of result.lines) {
    console.log(result.ok || !line.startsWith("NEW") ? line : `::error title=e2e-livedit new bug::${line}`);
  }
  process.exit(result.ok ? 0 : 1);
}
