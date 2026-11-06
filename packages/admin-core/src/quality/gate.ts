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
 *
 * #727 "optimum, not good enough" — the problems recorded on an audit are
 * everything off target (ratchet.ts); acceptances are applied HERE, live,
 * comparing the accepted value with the measured one. Accepting opens the
 * gate at once and revoking closes it at once. An audit recorded under
 * older rules (CURRENT_GATE_RULES) is not trusted: it blocks until checked
 * again.
 *
 * #1240 — a build that links pages without a version in the linking page's
 * language closes the gate on its own: a staging build renders those links
 * into another language, and Publish live copies it as it is. So no audit
 * result, acceptance or override opens it; only a new Stage does.
 *
 * #1446 — the same decision holds across pages when it is about a file
 * Caelo or a plugin ships (platform-audits.ts). The audit samples different
 * pages on each Stage, so an acceptance per page came back on every Stage
 * for a file the operator had already decided on. An acceptance of an audit
 * for such a file covers that audit for that file on every page, until the
 * content hash in its name changes. It covers a page's finding only when
 * the finding names nothing but accepted files, at a value no worse than
 * accepted: anything else on the page is the page's own problem and blocks.
 * Page scores are not part of this: a category below 100 stays per page.
 */

import type { LinkNotice } from "../links/link-notice.js";
import type { CheckRuleProblem } from "./checks/evaluate.js";
import { shippedResourcesOf } from "./platform-audits.js";
import {
  acceptedValueCovers,
  isPerformanceNoisy,
  problemValue,
  QUALITY_TARGET,
  type QualityCategory,
  type QualityProblem,
} from "./ratchet.js";

/**
 * The rules an audit is recorded under. Version 2 (#727, migration 0276):
 * the 100 target, every audit below 1 a finding, no per-page baselines.
 * An audit recorded under older rules hid debt the current rules block on,
 * so the gate does not trust its verdict: it asks for a new check.
 */
export const CURRENT_GATE_RULES = 2;

/** What the gate needs to know about the audit of the staged build. */
export interface GateAudit {
  readonly id: string;
  /** `quality_audit_runs.gate_rules`: the rules it was recorded under. */
  readonly gateRules: number;
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
    /** The audited URL: decides which flagged files are the site's own. */
    readonly pageUrl: string;
    readonly problems: readonly QualityProblem[];
  }[];
  /** #727 — site-wide findings-check problems (no page). */
  readonly siteProblems: readonly CheckRuleProblem[];
}

/** Live (unrevoked) acceptances of the audited pages. */
export interface GateAcceptances {
  /** `${pageId}|${auditId}` → the audit score accepted, in points (0..100);
   *  null for a finding accepted before values were recorded (0276). */
  readonly findings: ReadonlyMap<string, number | null>;
  /** `${pageId}|${category}` → accepted score. */
  readonly scores: ReadonlyMap<string, number>;
  /** #727 — `${pageId or "site"}|${ruleId}` → accepted error count. */
  readonly checks: ReadonlyMap<string, number>;
  /** #1446 — `${auditId}|${resourcePath}` → the audit score accepted for a
   *  file Caelo or a plugin ships, on every page that loads it. */
  readonly resources: ReadonlyMap<string, number>;
}

export type GateState =
  | "clean"
  | "accepted"
  | "overridden"
  | "missing"
  | "running"
  | "problems"
  | "errored"
  | "links";

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
  /** #1240 — state `links`: what the staged build links, with its actions. */
  readonly linkNotice?: LinkNotice;
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

/** #1446 — key of an acceptance of an audit for one shipped file. */
export function resourceKey(auditId: string, resourcePath: string): string {
  return `${auditId}|${resourcePath}`;
}

/** What an open problem is listed as when it has no page. */
export const SITE_WIDE_PATH = "site-wide";

/**
 * #1446 — whether acceptances for shipped files cover this finding: it
 * names shipped files only, each one accepted for this audit at a value no
 * worse than measured.
 */
function isAcceptedForResources(
  problem: Extract<QualityProblem, { kind: "failing_audit" }>,
  pageUrl: string,
  acceptances: GateAcceptances,
): boolean {
  const paths = shippedResourcesOf(problem.elements, pageUrl);
  if (paths === null) return false;
  return paths.every((path) => {
    const accepted = acceptances.resources.get(resourceKey(problem.auditId, path));
    return (
      accepted !== undefined &&
      acceptedValueCovers(problemValue(problem), accepted, isPerformanceNoisy(problem))
    );
  });
}

/**
 * True when an editor's live acceptance covers the problem: on this page,
 * or for the shipped files the finding names (#1446). The accepted value is
 * not worse than what was measured (ratchet.ts — Performance values within
 * ACCEPTED_PERFORMANCE_TOLERANCE of it).
 *
 * @param pageUrl - the audited URL of the page; null with a null `pageId`
 */
export function isProblemAccepted(
  pageId: string | null,
  problem: QualityProblem,
  acceptances: GateAcceptances,
  pageUrl: string | null,
): boolean {
  if (problem.kind === "check_rule") {
    // The per-rule ratchet: accepted up to a count of errors; one more blocks.
    const accepted = acceptances.checks.get(checkKey(pageId, problem.ruleId));
    return accepted !== undefined && problem.count <= accepted;
  }
  if (pageId === null) return false;
  const accepted =
    problem.kind === "failing_audit"
      ? acceptances.findings.get(findingKey(pageId, problem.auditId))
      : acceptances.scores.get(scoreKey(pageId, problem.category));
  // A finding accepted before values were recorded covers it as recorded.
  if (accepted === null) return true;
  if (
    accepted !== undefined &&
    acceptedValueCovers(problemValue(problem), accepted, isPerformanceNoisy(problem))
  ) {
    return true;
  }
  return (
    problem.kind === "failing_audit" &&
    pageUrl !== null &&
    isAcceptedForResources(problem, pageUrl, acceptances)
  );
}

function describeProblem(p: OpenProblem): string {
  switch (p.problem.kind) {
    case "failing_audit":
      return `${p.pagePath}: ${p.problem.auditId}`;
    case "score_below_baseline":
      return `${p.pagePath}: ${p.problem.category} ${p.problem.score} < ${QUALITY_TARGET}`;
    case "check_rule":
      return `${p.pagePath}: ${p.problem.ruleId} (${p.problem.count}×)`;
  }
}

/**
 * Decide the gate for the staged build.
 *
 * @param audit - the newest audit of the staging deploy run Publish would
 *   ship, or null when that run was never audited.
 * @param linkNotice - the language links that run's build rendered (#1240).
 */
export function decideGate(
  audit: GateAudit | null,
  acceptances: GateAcceptances,
  linkNotice: LinkNotice | null = null,
): GateDecision {
  if (linkNotice !== null) {
    return {
      open: false,
      state: "links",
      auditRunId: audit?.id ?? null,
      openProblems: [],
      canPublishAnyway: false,
      message: `Publish live is blocked. ${linkNotice.operatorText}`,
      linkNotice,
    };
  }
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
  if (
    audit.gateRules < CURRENT_GATE_RULES &&
    (audit.status === "passed" || audit.status === "problems" || audit.status === "skipped")
  ) {
    return {
      open: false,
      state: "missing",
      auditRunId: audit.id,
      openProblems: [],
      canPublishAnyway: false,
      message:
        "Publish live is blocked: the staged build was checked under the earlier quality rules, which let scores below 100 and existing findings pass. Run the check again under the current rules (retry_quality_audit, or 'Run quality check' in the toolbar), or Stage again.",
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
          "Publish live is blocked until the quality check of the staged build finishes (usually 2–4 minutes). Try again when it is done.",
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
          if (!isProblemAccepted(page.pageId, problem, acceptances, page.pageUrl)) {
            openProblems.push({ pageId: page.pageId, pagePath: page.pagePath, problem });
          }
        }
      }
      for (const problem of audit.siteProblems) {
        if (!isProblemAccepted(null, problem, acceptances, null)) {
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
        message: `Publish live is blocked by ${openProblems.length} quality problem(s): ${shown}${more}. The target is 100 in every category and zero findings — fix them and Stage again (get_quality_audit has the details and the metrics; findings it marks CAELO PLATFORM are Caelo bugs — report them with bug_report). Only what truly cannot be fixed goes to the operator as one decision per group of findings (accept_quality_findings with groups); never call a score below 100 good enough.`,
      };
    }
  }
}
