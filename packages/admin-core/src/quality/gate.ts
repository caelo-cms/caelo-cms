// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the Publish-live gate decision. Pure: the ops load the
 * newest audit of the staging build that would go live, plus the pages'
 * live acceptances, and this decides whether Publish may proceed and what
 * the operator / AI is told otherwise.
 *
 * Maintainer decisions (#553):
 * - a clean (passed) or legitimately skipped audit lets Publish through;
 * - problems block until each is fixed (re-Stage → clean audit) or
 *   accepted on its page — acceptances count immediately, without a new
 *   audit, because they only change what counts, not what was measured;
 * - an audit that FAILED (no result: browser, timeout, staging
 *   unreachable, …) blocks by default; an editor may publish anyway with
 *   an explicit, recorded click. Never the AI on its own;
 * - a staged build without any audit, or one still running, blocks.
 */

import type { QualityCategory, QualityProblem } from "./ratchet.js";

/** What the gate needs to know about the audit of the staged build. */
export interface GateAudit {
  readonly id: string;
  readonly status:
    | "queued"
    | "running"
    | "passed"
    | "problems"
    | "errored"
    | "skipped"
    | "superseded";
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** Set when an editor chose "publish anyway" over this failed audit. */
  readonly publishOverride: { readonly by: string; readonly reason: string } | null;
  readonly pages: readonly {
    readonly pageId: string;
    readonly pagePath: string;
    readonly problems: readonly QualityProblem[];
  }[];
}

/** Live (unrevoked) acceptances of the audited pages. */
export interface GateAcceptances {
  /** `${pageId}|${auditId}` for accepted findings. */
  readonly findings: ReadonlySet<string>;
  /** `${pageId}|${category}` → accepted score. */
  readonly scores: ReadonlyMap<string, number>;
}

export type GateState =
  | "clean"
  | "accepted"
  | "overridden"
  | "missing"
  | "running"
  | "problems"
  | "errored";

export interface OpenProblem {
  readonly pageId: string;
  readonly pagePath: string;
  readonly problem: QualityProblem;
}

export interface GateDecision {
  readonly open: boolean;
  readonly state: GateState;
  readonly auditRunId: string | null;
  /** Problems no acceptance covers (empty unless state = problems). */
  readonly openProblems: readonly OpenProblem[];
  /** Operator- and AI-facing explanation with the next step. Empty when
   *  the gate is open on a clean audit. */
  readonly message: string;
  /** "Publish anyway" is on offer (a failed audit, not yet overridden). */
  readonly canPublishAnyway: boolean;
}

/** Key helpers shared with the loaders. */
export function findingKey(pageId: string, auditId: string): string {
  return `${pageId}|${auditId}`;
}
export function scoreKey(pageId: string, category: QualityCategory): string {
  return `${pageId}|${category}`;
}

/** True when an editor's acceptance on this page covers the problem. */
export function isProblemAccepted(
  pageId: string,
  problem: QualityProblem,
  acceptances: GateAcceptances,
): boolean {
  if (problem.kind === "failing_audit") {
    return acceptances.findings.has(findingKey(pageId, problem.auditId));
  }
  const accepted = acceptances.scores.get(scoreKey(pageId, problem.category));
  return accepted !== undefined && problem.score >= accepted;
}

function describeProblem(p: OpenProblem): string {
  return p.problem.kind === "failing_audit"
    ? `${p.pagePath}: ${p.problem.auditId}`
    : `${p.pagePath}: ${p.problem.category} ${p.problem.score} < ${p.problem.baseline}`;
}

/**
 * Decide the gate for the staged build.
 *
 * @param audit - the newest audit of the staging deploy run Publish would
 *   ship, or null when that run was never audited.
 */
export function decideGate(audit: GateAudit | null, acceptances: GateAcceptances): GateDecision {
  if (audit === null || audit.status === "superseded") {
    return {
      open: false,
      state: "missing",
      auditRunId: audit?.id ?? null,
      openProblems: [],
      canPublishAnyway: false,
      message:
        "Publish live is blocked: the staged build has not been quality-checked. Run the audit (retry_quality_audit, or 'Run quality check' in the toolbar), or Stage again.",
    };
  }
  switch (audit.status) {
    case "queued":
    case "running":
      return {
        open: false,
        state: "running",
        auditRunId: audit.id,
        openProblems: [],
        canPublishAnyway: false,
        message:
          "Publish live is blocked until the quality check of the staged build finishes (usually 1–2 minutes). Try again when it is done.",
      };
    case "passed":
    case "skipped":
      return {
        open: true,
        state: "clean",
        auditRunId: audit.id,
        openProblems: [],
        canPublishAnyway: false,
        message: "",
      };
    case "errored":
      if (audit.publishOverride) {
        return {
          open: true,
          state: "overridden",
          auditRunId: audit.id,
          openProblems: [],
          canPublishAnyway: false,
          message: `The quality check failed, and an editor chose to publish anyway: ${audit.publishOverride.reason}`,
        };
      }
      return {
        open: false,
        state: "errored",
        auditRunId: audit.id,
        openProblems: [],
        canPublishAnyway: true,
        message: `Publish live is blocked: the quality check failed (${audit.errorCode ?? "error"}: ${audit.errorMessage ?? "no reason recorded"}). Retry it (retry_quality_audit, or 'Retry check' in the toolbar). An editor may instead publish anyway with an explicit, recorded decision (publish_despite_failed_audit).`,
      };
    case "problems": {
      const openProblems: OpenProblem[] = [];
      for (const page of audit.pages) {
        for (const problem of page.problems) {
          if (!isProblemAccepted(page.pageId, problem, acceptances)) {
            openProblems.push({ pageId: page.pageId, pagePath: page.pagePath, problem });
          }
        }
      }
      if (openProblems.length === 0) {
        return {
          open: true,
          state: "accepted",
          auditRunId: audit.id,
          openProblems: [],
          canPublishAnyway: false,
          message: "Every quality problem of the staged build was accepted by an editor.",
        };
      }
      const shown = openProblems.slice(0, 5).map(describeProblem).join("; ");
      const more = openProblems.length > 5 ? ` and ${openProblems.length - 5} more` : "";
      return {
        open: false,
        state: "problems",
        auditRunId: audit.id,
        openProblems,
        canPublishAnyway: false,
        message: `Publish live is blocked by ${openProblems.length} quality problem(s): ${shown}${more}. Fix them and Stage again (get_quality_audit has the details), or have an editor accept the ones that are intended (accept_quality_findings).`,
      };
    }
  }
}
