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
  type BugReportCiRun,
  bugIntakeReport,
  computeBugFingerprint,
  redactBugReportFields,
} from "@caelo-cms/shared";

/** The `ai_bug_reports` columns a payload is built from. */
export interface ForwardableBugReport {
  id: string;
  fingerprint: string | null;
  source: string;
  /** 'defect' | 'suggestion' (migration 0391; every older row is a defect). */
  kind: string;
  /** Null for a suggestion. */
  severity: string | null;
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
 * #1416 — the CI run this process serves, when it forwards reports for one
 * (the real-AI workflow sets `CAELO_E2E_FORWARD_BUGS=1`); undefined on an
 * install. A run that forwards without saying which run it is would pass for
 * a user install, so missing GitHub variables fail loudly.
 */
export function ciRunOfProcess(env: NodeJS.ProcessEnv = process.env): BugReportCiRun | undefined {
  if (env.CAELO_E2E_FORWARD_BUGS !== "1") return undefined;
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA } = env;
  const branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GITHUB_SHA || !branch) {
    throw new Error(
      "CAELO_E2E_FORWARD_BUGS=1 outside a GitHub Actions run: it needs GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA and a branch. Unset it for a local run.",
    );
  }
  return {
    runUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
    branch,
    commit: GITHUB_SHA,
  };
}

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
  const ciRun = ciRunOfProcess();
  return bugIntakeReport.parse({
    protocolVersion: BUG_INTAKE_PROTOCOL_VERSION,
    reportId: row.id,
    caeloVersion: row.caeloVersion ?? UNKNOWN_FILING_VERSION,
    fingerprint,
    source,
    // Sent as stored: the intake files a suggestion under its own label and
    // daily cap (#1192). The contract refuses a kind it does not know.
    kind: row.kind,
    severity: row.severity,
    blockedTask: row.blockedTask,
    suspectedTool: row.suspectedTool,
    ...redacted,
    ...(ciRun ? { ciRun } : {}),
  });
}
