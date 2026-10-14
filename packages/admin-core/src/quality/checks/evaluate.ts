// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — the per-rule ratchet of the findings checks. Pure.
 *
 * A findings check has no score; it has, per page (or for the site) and
 * rule, a COUNT of error findings. The target is 0:
 *
 * - Every rule with an error finding is a problem and blocks Publish live
 *   — pre-existing debt is not grandfathered in.
 * - An editor's acceptance records the count it accepted ("3 images
 *   without alt on /team"). The GATE applies it live (gate.ts): up to that
 *   count the rule passes; a NEW error beyond it blocks again. The problem
 *   itself stays recorded with what was measured, so revoking the
 *   acceptance blocks again at once, without a new audit.
 * - When fewer errors are measured than accepted, the accepted count drops
 *   to what was measured (an acceptance at 0 is spent and revoked): quality
 *   only ratchets up, exactly like an accepted Lighthouse score.
 *
 * Warnings and info are reported, never counted.
 */

import { checkIdOfRule, type Finding, type FindingFix } from "./findings.js";

/** Problem rows keep this many example findings for the AI. */
export const PROBLEM_EXAMPLE_LIMIT = 5;

/** One rule with error findings, on one page or site-wide. */
export interface CheckRuleProblem {
  readonly kind: "check_rule";
  readonly checkId: string;
  readonly ruleId: string;
  /** Error findings of the rule measured now. */
  readonly count: number;
  /** Error findings an editor's acceptance allowed when the audit was
   *  recorded (0 without one) — for the record; the gate reads the live
   *  acceptance. */
  readonly allowed: number;
  /** The first findings, so the AI can act without another read. */
  readonly findings: readonly { readonly message: string; readonly fix?: FindingFix }[];
}

/** Error findings per rule, in first-seen order. */
export function errorsByRule(findings: readonly Finding[]): Map<string, Finding[]> {
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    if (f.severity !== "error") continue;
    const list = byRule.get(f.ruleId);
    if (list) list.push(f);
    else byRule.set(f.ruleId, [f]);
  }
  return byRule;
}

/**
 * The problems of one page (or of the site): every rule with an error
 * finding, accepted or not (the gate decides what an acceptance covers).
 *
 * @param findings - every finding of that page (or the page-less ones).
 * @param acceptedCounts - live acceptances there: rule id → accepted count,
 *   recorded on the problem as `allowed`.
 */
export function evaluateCheckFindings(
  findings: readonly Finding[],
  acceptedCounts: ReadonlyMap<string, number>,
): CheckRuleProblem[] {
  const problems: CheckRuleProblem[] = [];
  for (const [ruleId, errors] of errorsByRule(findings)) {
    const allowed = acceptedCounts.get(ruleId) ?? 0;
    problems.push({
      kind: "check_rule",
      checkId: checkIdOfRule(ruleId),
      ruleId,
      count: errors.length,
      allowed,
      findings: errors
        .slice(0, PROBLEM_EXAMPLE_LIMIT)
        .map((f) => (f.fix ? { message: f.message, fix: f.fix } : { message: f.message })),
    });
  }
  return problems;
}

/**
 * Acceptances the ratchet tightens after this measurement: rule id → the
 * new accepted count (0 = spent, revoke it). Only rules of checks that
 * actually measured here (`measuredCheckIds`) move — a check that failed
 * measured nothing, and its acceptances stay as they are.
 */
export function tightenedAcceptances(
  acceptedCounts: ReadonlyMap<string, number>,
  findings: readonly Finding[],
  measuredCheckIds: ReadonlySet<string>,
): Map<string, number> {
  const measured = errorsByRule(findings);
  const next = new Map<string, number>();
  for (const [ruleId, accepted] of acceptedCounts) {
    if (!measuredCheckIds.has(checkIdOfRule(ruleId))) continue;
    const count = measured.get(ruleId)?.length ?? 0;
    if (count < accepted) next.set(ruleId, count);
  }
  return next;
}
