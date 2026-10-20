// SPDX-License-Identifier: MPL-2.0

/**
 * The one place that turns an `ai_bug_reports` row into the bytes sent to
 * the Caelo bug intake (epic #901). The Owner's preview on /settings/bugs and
 * the forwarding worker both call {@link buildIntakeReport}, so what the
 * Owner reviewed is exactly what leaves the install.
 */

import {
  BUG_INTAKE_PROTOCOL_VERSION,
  type BugIntakeReport,
  bugIntakeReport,
  CAELO_VERSION,
  computeBugFingerprint,
  redactBugReportFields,
} from "@caelo-cms/shared";

/** The `ai_bug_reports` columns a payload is built from. */
export interface ForwardableBugReport {
  id: string;
  fingerprint: string | null;
  source: string;
  severity: string;
  blockedTask: boolean;
  suspectedTool: string | null;
  title: string;
  whatHappened: string;
  expected: string;
  evidence: string | null;
}

/**
 * Build the redacted, schema-checked intake payload for one report. Rows
 * filed before migration 0318 have no stored fingerprint; it is computed
 * here from the same fields, so they forward like any other row.
 */
export async function buildIntakeReport(row: ForwardableBugReport): Promise<BugIntakeReport> {
  const source = row.source === "auto" ? "auto" : "ai";
  const fingerprint =
    row.fingerprint ??
    (await computeBugFingerprint({
      source,
      suspectedTool: row.suspectedTool,
      title: row.title,
      whatHappened: row.whatHappened,
    }));
  const redacted = redactBugReportFields({
    title: row.title,
    whatHappened: row.whatHappened,
    expected: row.expected,
    evidence: row.evidence,
  });
  return bugIntakeReport.parse({
    protocolVersion: BUG_INTAKE_PROTOCOL_VERSION,
    reportId: row.id,
    caeloVersion: CAELO_VERSION,
    fingerprint,
    source,
    severity: row.severity,
    blockedTask: row.blockedTask,
    suspectedTool: row.suspectedTool,
    ...redacted,
  });
}
