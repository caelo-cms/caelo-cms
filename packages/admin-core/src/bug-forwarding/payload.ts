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
  /** The release that filed the row; null for rows filed before migration 0348. */
  caeloVersion: string | null;
}

/**
 * What a report filed before migration 0348 forwards as its version. Its
 * filing version was never recorded, and stamping the release that sends it
 * would claim the defect was seen on a release that may contain its fix
 * (#1072). The intake never reads an unparseable version as a regression.
 */
export const UNKNOWN_FILING_VERSION = "unknown";

/**
 * Build the redacted, schema-checked intake payload for one report. Rows
 * filed before migration 0330 have no stored fingerprint; it is computed
 * here from the same fields, so they forward like any other row. The
 * version is the one stored when the report was filed, not the release
 * that sends it.
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
    caeloVersion: row.caeloVersion ?? UNKNOWN_FILING_VERSION,
    fingerprint,
    source,
    severity: row.severity,
    blockedTask: row.blockedTask,
    suspectedTool: row.suspectedTool,
    ...redacted,
  });
}
