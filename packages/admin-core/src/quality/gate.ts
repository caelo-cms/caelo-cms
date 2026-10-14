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
 *
 * #667 — findings caused by Caelo itself (platform-audits.ts: back/forward
 * cache, caching of Caelo's own files, compression, …) block like any
 * other finding, including a Performance drop they cause. Exempting them
 * was considered and rejected: the exemption would be a silent fallback
 * (CLAUDE.md §2) that hides real regressions of the serving stack — exactly
 * the bugs #667 fixed went unnoticed while they were "not the site's
 * fault" — and a Performance score has no per-audit attribution to
 * subtract them honestly. They are reported as Caelo bugs instead, the
 * root causes are fixed in the platform, and until then only an editor's
 * explicit acceptance lets the build through. The AI never recommends one.
 *
 * #727 — page-check problems (checks/evaluate.ts) gate the same way: an
 * error rule over its accepted count blocks until fixed or accepted, on its
 * page or, for a page-less finding, site-wide. Warnings never reach here.
 */

import type { CheckRuleProblem } from "./checks/evaluate.js";
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
  /** #727 — site-wide findings-check problems (no page). */
  readonly siteProblems: readonly CheckRuleProblem[];
}

/** Live (unrevoked) acceptances of the audited pages. */
export interface GateAcceptances {
  /** `${pageId}|${auditId}` for accepted findings. */
  readonly findings: ReadonlySet<string>;
  /** `${pageId}|${category}` → accepted score. */
  readonly scores: ReadonlyMap<string, number>;
  /** #727 — `${pageId or "site"}|${ruleId}` → accepted error count. */
  readonly checks: ReadonlyMap<string, number>;
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
  /** Null for a site-wide problem. */
  readonly pageId: string | null;
  /** The page's path, or "site-wide". */
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
/** #727 — key of a findings-check acceptance (`pageId` null = site-wide). */
export function checkKey(pageId: string | null, ruleId: string): string {
  return `${pageId ?? "site"}|${ruleId}`;
}

/** What an open problem is listed as when it has no page. */
export const SITE_WIDE_PATH = "site-wide";

/** True when an editor's acceptance on this page covers the problem. */
export function isProblemAccepted(
  pageId: string | null,
  problem: QualityProblem,
  acceptances: GateAcceptances,
): boolean {
  if (problem.kind === "check_rule") {
    // The per-rule ratchet: accepted up to a count of errors; one more blocks.
    const accepted = acceptances.checks.get(checkKey(pageId, problem.ruleId));
    return accepted !== undefined && problem.count <= accepted;
  }
  if (pageId === null) return false;
  if (problem.kind === "failing_audit") {
    return acceptances.findings.has(findingKey(pageId, problem.auditId));
  }
  const accepted = acceptances.scores.get(scoreKey(pageId, problem.category));
  return accepted !== undefined && problem.score >= accepted;
}

function describeProblem(p: OpenProblem): string {
  switch (p.problem.kind) {
    case "failing_audit":
      return `${p.pagePath}: ${p.problem.auditId}`;
    case "score_below_baseline":
      return `${p.pagePath}: ${p.problem.category} ${p.problem.score} < ${p.problem.baseline}`;
    case "check_rule":
      return `${p.pagePath}: ${p.problem.ruleId} (${p.problem.count}×)`;
  }
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
      for (const problem of audit.siteProblems) {
        if (!isProblemAccepted(null, problem, acceptances)) {
          openProblems.push({ pageId: null, pagePath: SITE_WIDE_PATH, problem });
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
        message: `Publish live is blocked by ${openProblems.length} quality problem(s): ${shown}${more}. Fix them and Stage again (get_quality_audit has the details; findings it marks CAELO PLATFORM are Caelo bugs — report them with bug_report). What cannot be fixed stays blocking until an editor decides to accept it — accept_quality_findings only on the editor's explicit request, never as the AI's recommendation.`,
      };
    }
  }
}
