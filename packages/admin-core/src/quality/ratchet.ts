// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 / #727 — what the Lighthouse part of an audit finds on a page,
 * and how an editor's acceptance is compared with it. Pure functions only:
 * the audit worker feeds them one page's measurement, and the gate feeds
 * them the live acceptances.
 *
 * Maintainer decision on #727 (2026-10-14, "optimum, not good enough"):
 * - The target is 100 in every category and a passing score (1) on every
 *   scored audit. A 90 is not "fine": every category below 100 and every
 *   scored audit below 1 is a problem that blocks Publish live.
 * - No grandfathering. There is no per-page baseline any more (the
 *   `quality_baselines` ratchet of #553 let existing debt pass): a problem
 *   blocks until it is fixed or an editor accepts it on its page.
 * - An acceptance records the VALUE it accepted (a category score, an
 *   audit's score, a check rule's error count). A measurement worse than
 *   that value blocks again; a better one tightens the acceptance (it only
 *   ratchets up), except where noise makes "better" meaningless (below).
 *
 * Measurement noise, handled explicitly and nowhere else:
 * - Performance is the median of several runs (`medianScore`), and an
 *   audit that belongs only to Performance counts when it fails in a
 *   majority of the runs (lighthouse-extract.ts). Nothing else is smoothed:
 *   no "good enough" bar, no consecutive-audit guard.
 * - Even the median jitters by a point or two between audits of an
 *   unchanged page. So when — and ONLY when — a Performance value is
 *   compared with an editor's acceptance, it may be up to
 *   ACCEPTED_PERFORMANCE_TOLERANCE points below the accepted value before
 *   it counts as "worse". Without an acceptance there is no tolerance: 99
 *   is a problem. Performance acceptances are also never tightened or
 *   spent automatically (a lucky run would raise the bar to noise); they
 *   stay until an editor revokes them.
 * - The same tolerance decides whether get_quality_audit points out a
 *   Performance score as "dropped since the previous audit"
 *   (`droppedSincePrevious`). That is a hint for where to look first, not
 *   a gate: the score below 100 blocks either way.
 */

import type { CheckRuleProblem } from "./checks/evaluate.js";
import type { PerformanceMetrics } from "./lighthouse-metrics.js";

/** The four Lighthouse categories the gate audits, in report order. */
export const QUALITY_CATEGORIES = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
] as const;

export type QualityCategory = (typeof QUALITY_CATEGORIES)[number];

/** The score every category is held to. */
export const QUALITY_TARGET = 100;

/**
 * Points a Performance value (category score, or the score of an audit
 * that belongs only to Performance) may fall below an editor's ACCEPTED
 * value before it counts as worse. Measurement noise of the Performance
 * median, observed at 1–2 points; never applied against the target.
 */
export const ACCEPTED_PERFORMANCE_TOLERANCE = 2;

/** One failing Lighthouse audit on a page, reduced to what the gate and
 *  the AI need. `categories` are the gated categories referencing it. */
export interface FailingAudit {
  readonly id: string;
  readonly title: string;
  /** 0..1 Lighthouse audit score. */
  readonly score: number;
  readonly categories: readonly QualityCategory[];
  /** Lighthouse's short summary (e.g. "2 elements", "Potential savings of 120 KiB"). */
  readonly displayValue?: string;
  /** The page elements the audit flagged (first few), so the fix can go
   *  to the right module instead of being guessed from the audit title. */
  readonly elements?: readonly FlaggedElement[];
}

/** One element a Lighthouse audit flagged, as Lighthouse describes it. */
export interface FlaggedElement {
  /** CSS selector Lighthouse resolved for the node. */
  readonly selector?: string;
  /** The element's opening HTML (truncated by Lighthouse). */
  readonly snippet?: string;
  /** Lighthouse's short label (often the element's text). */
  readonly label?: string;
  /** Why it failed, e.g. the measured contrast ratio and the colours — or,
   *  for a console entry, its source and message. */
  readonly explanation?: string;
  /** The script or resource a console entry came from (e.g. the URL that
   *  404'd), so the fix goes to that URL instead of being guessed. */
  readonly url?: string;
}

/** The measured state of one page in one audit. Scores are 0..100. */
export interface PageMeasurement {
  readonly scores: Readonly<Record<QualityCategory, number>>;
  readonly failingAudits: readonly FailingAudit[];
  /** The Performance metrics (FCP, LCP, TBT, CLS, SI) behind the
   *  Performance score. Data for the AI, never a problem on their own. */
  readonly metrics: PerformanceMetrics;
}

/** A problem the Lighthouse part of an audit found on a page. */
export type LighthouseProblem =
  | {
      readonly kind: "failing_audit";
      readonly auditId: string;
      readonly title: string;
      readonly score: number;
      readonly categories: readonly QualityCategory[];
      readonly displayValue?: string;
      readonly elements?: readonly FlaggedElement[];
    }
  | {
      /**
       * A category below the target. The stored kind and the `baseline`
       * field keep their #553 names so the previous image still reads new
       * rows (expand-only releases, #696); `baseline` is always
       * QUALITY_TARGET now.
       */
      readonly kind: "score_below_baseline";
      readonly category: QualityCategory;
      readonly score: number;
      readonly baseline: number;
    };

/**
 * Anything that blocks Publish live on a page: a Lighthouse problem, or a
 * findings-check rule with error findings (#727, checks/evaluate.ts).
 */
export type QualityProblem = LighthouseProblem | CheckRuleProblem;

/**
 * Every problem of one page's measurement: each category below the target
 * and each failing audit. Acceptances are NOT applied here — the gate
 * applies them live (gate.ts), so accepting or revoking counts at once,
 * without a new audit.
 */
export function evaluatePage(measurement: PageMeasurement): LighthouseProblem[] {
  const problems: LighthouseProblem[] = [];
  for (const category of QUALITY_CATEGORIES) {
    const score = measurement.scores[category];
    if (score < QUALITY_TARGET) {
      problems.push({ kind: "score_below_baseline", category, score, baseline: QUALITY_TARGET });
    }
  }
  for (const audit of measurement.failingAudits) {
    problems.push({
      kind: "failing_audit",
      auditId: audit.id,
      title: audit.title,
      score: audit.score,
      categories: audit.categories,
      ...(audit.displayValue !== undefined ? { displayValue: audit.displayValue } : {}),
      ...(audit.elements !== undefined ? { elements: audit.elements } : {}),
    });
  }
  return problems;
}

/** A 0..1 Lighthouse audit score as the 0..100 points acceptances store. */
export function auditScorePoints(score: number): number {
  return Math.round(score * 100);
}

/** Whether an audit is referenced by the Performance category only. */
function performanceOnly(categories: readonly QualityCategory[]): boolean {
  return categories.length > 0 && categories.every((c) => c === "performance");
}

/** Whether a Lighthouse problem is measured with Performance noise: the
 *  Performance category score, or an audit only Performance references. */
export function isPerformanceNoisy(problem: LighthouseProblem): boolean {
  if (problem.kind === "score_below_baseline") return problem.category === "performance";
  return performanceOnly(problem.categories);
}

/**
 * Whether a measured value (0..100 points) is still covered by an editor's
 * accepted value. The tolerance applies only to noisy (Performance)
 * values; a deterministic value must not be any worse.
 */
export function acceptedValueCovers(measured: number, accepted: number, noisy: boolean): boolean {
  return measured >= accepted - (noisy ? ACCEPTED_PERFORMANCE_TOLERANCE : 0);
}

/**
 * Whether a category score dropped since the page's previous comparable
 * audit, beyond measurement noise: Performance must fall more than
 * ACCEPTED_PERFORMANCE_TOLERANCE points, the deterministic categories any
 * point. Only steers the "check recent changes first" hint; it never
 * decides whether the score blocks.
 */
export function droppedSincePrevious(
  category: QualityCategory,
  current: number,
  previous: number,
): boolean {
  return !acceptedValueCovers(current, previous, category === "performance");
}

/** The 0..100 value of a Lighthouse problem that an acceptance compares. */
export function problemValue(problem: LighthouseProblem): number {
  return problem.kind === "score_below_baseline" ? problem.score : auditScorePoints(problem.score);
}

/** A live Lighthouse acceptance on one page, as the tightening reads it. */
export interface LighthouseAcceptance {
  readonly id: string;
  readonly kind: "finding" | "score";
  /** The audit id (finding) or the category (score). */
  readonly key: string;
  /** The accepted value in points; null for a finding accepted before
   *  values were recorded and not backfillable by migration 0276. */
  readonly accepted: number | null;
}

/** What to do with an acceptance after a measurement: raise its value, or
 *  revoke it because the page now meets the target ("spend"). */
export type AcceptanceUpdate =
  | { readonly id: string; readonly action: "tighten"; readonly value: number }
  | { readonly id: string; readonly action: "spend" };

/**
 * The acceptance ratchet of one page after a Lighthouse measurement:
 * - a deterministic category at the target spends its score acceptance; a
 *   better score raises it;
 * - a deterministic finding that still fails, at a better score, raises
 *   its acceptance. A passing audit leaves its acceptance as recorded: the
 *   measurement does not say which categories a passing audit belongs to,
 *   so a deterministic pass cannot be told from a noisy one;
 * - Performance acceptances never move automatically (noise, see top).
 */
export function lighthouseAcceptanceUpdates(
  acceptances: readonly LighthouseAcceptance[],
  measurement: PageMeasurement,
): AcceptanceUpdate[] {
  const updates: AcceptanceUpdate[] = [];
  for (const a of acceptances) {
    if (a.accepted === null) continue;
    if (a.kind === "score") {
      if (a.key === "performance") continue;
      const score = measurement.scores[a.key as QualityCategory];
      if (score === undefined) continue;
      if (score >= QUALITY_TARGET) updates.push({ id: a.id, action: "spend" });
      else if (score > a.accepted) updates.push({ id: a.id, action: "tighten", value: score });
      continue;
    }
    const failing = measurement.failingAudits.find((f) => f.id === a.key);
    if (!failing || performanceOnly(failing.categories)) continue;
    const value = auditScorePoints(failing.score);
    if (value > a.accepted) updates.push({ id: a.id, action: "tighten", value });
  }
  return updates;
}

/** Median of a non-empty list of scores (mean of the middle pair for an
 *  even count, rounded). Throws on an empty list: an audit without a
 *  Performance run is an infrastructure failure, never a score. */
export function medianScore(values: readonly number[]): number {
  if (values.length === 0)
    throw new Error("medianScore: no Performance runs to take the median of");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}
