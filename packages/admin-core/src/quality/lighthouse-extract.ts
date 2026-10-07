// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — reduce Lighthouse results (LHRs) to the compact
 * `PageMeasurement` the ratchet evaluates. Pure; runs inside the audit
 * child process so the multi-megabyte LHR never crosses the process
 * boundary.
 *
 * Lighthouse is loaded dynamically (no static types), so the LHR shape is
 * typed here with only the fields we read.
 */

import {
  type FailingAudit,
  medianScore,
  type PageMeasurement,
  QUALITY_CATEGORIES,
  type QualityCategory,
} from "./ratchet.js";

/** The subset of a Lighthouse result this module reads. */
export interface LhrLike {
  readonly requestedUrl?: string;
  readonly finalDisplayedUrl?: string;
  readonly runtimeError?: { readonly code: string; readonly message: string };
  readonly categories: Readonly<
    Record<
      string,
      {
        readonly score: number | null;
        readonly auditRefs: readonly { readonly id: string; readonly group?: string }[];
      }
    >
  >;
  readonly audits: Readonly<
    Record<
      string,
      {
        readonly id: string;
        readonly title: string;
        readonly score: number | null;
        readonly scoreDisplayMode: string;
        readonly displayValue?: string;
      }
    >
  >;
}

/** Thrown when a run produced no usable result (page unreachable, 404,
 *  no paint, …). The audit records it as an infrastructure failure. */
export class LighthouseRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LighthouseRunError";
  }
}

/** Lighthouse's own pass threshold (report-utils `showAsPassed`). */
const PASS_MIN_SCORE = 0.9;

/** Score display modes that can fail. `informative`, `manual`,
 *  `notApplicable` and `error` never count as findings. */
const SCORED_MODES = new Set(["binary", "numeric", "metricSavings"]);

/** Audit groups that never become findings: hidden audits, and the
 *  Performance metrics (FCP, LCP, TBT, CLS, SI), which the category score
 *  already measures. */
const NON_FINDING_GROUPS = new Set(["hidden", "metrics"]);

function assertUsable(lhr: LhrLike): void {
  if (lhr.runtimeError) {
    throw new LighthouseRunError(lhr.runtimeError.code, lhr.runtimeError.message);
  }
}

/** 0..100 integer score per requested category. Throws when a requested
 *  category has no score (Lighthouse could not compute it). */
export function categoryScores(
  lhr: LhrLike,
  categories: readonly QualityCategory[],
): Record<QualityCategory, number> {
  assertUsable(lhr);
  const out = {} as Record<QualityCategory, number>;
  for (const c of categories) {
    const score = lhr.categories[c]?.score;
    if (score === null || score === undefined) {
      throw new LighthouseRunError(
        "CATEGORY_UNSCORED",
        `Lighthouse returned no ${c} score for ${lhr.requestedUrl ?? "the page"}`,
      );
    }
    out[c] = Math.round(score * 100);
  }
  return out;
}

/** Failing audits of one run, with the gated categories that reference
 *  each (ordered by audit id for stable output). */
export function failingAudits(lhr: LhrLike): FailingAudit[] {
  assertUsable(lhr);
  const categoriesOf = new Map<string, QualityCategory[]>();
  for (const category of QUALITY_CATEGORIES) {
    for (const ref of lhr.categories[category]?.auditRefs ?? []) {
      if (ref.group !== undefined && NON_FINDING_GROUPS.has(ref.group)) continue;
      const list = categoriesOf.get(ref.id) ?? [];
      list.push(category);
      categoriesOf.set(ref.id, list);
    }
  }
  const out: FailingAudit[] = [];
  for (const [id, categories] of categoriesOf) {
    const audit = lhr.audits[id];
    if (!audit || audit.score === null || !SCORED_MODES.has(audit.scoreDisplayMode)) continue;
    if (audit.score >= PASS_MIN_SCORE) continue;
    out.push({
      id,
      title: audit.title,
      score: audit.score,
      categories,
      ...(audit.displayValue ? { displayValue: audit.displayValue } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Combine one full run (all four categories) and the extra Performance
 * runs into the page's measurement.
 *
 * - Performance score: median over the full run's and the extra runs'
 *   Performance scores.
 * - Accessibility, Best Practices, SEO: the full run (deterministic).
 * - Findings that belong only to Performance count when they fail in a
 *   majority of the Performance runs; everything else comes from the full
 *   run.
 *
 * @returns the measurement plus every Performance score, for the record.
 */
export function measurementFromRuns(
  fullRun: LhrLike,
  extraPerformanceRuns: readonly LhrLike[],
): { measurement: PageMeasurement; performanceRuns: number[] } {
  const scores = categoryScores(fullRun, QUALITY_CATEGORIES);
  const performanceRuns = [
    scores.performance,
    ...extraPerformanceRuns.map((r) => categoryScores(r, ["performance"]).performance),
  ];
  const isPerformanceOnly = (f: FailingAudit) => f.categories.every((c) => c === "performance");
  const findings = failingAudits(fullRun).filter((f) => !isPerformanceOnly(f));
  const perfOnly = new Map<string, { finding: FailingAudit; count: number }>();
  for (const run of [fullRun, ...extraPerformanceRuns]) {
    for (const f of failingAudits(run)) {
      if (!isPerformanceOnly(f)) continue;
      const seen = perfOnly.get(f.id);
      perfOnly.set(f.id, { finding: seen?.finding ?? f, count: (seen?.count ?? 0) + 1 });
    }
  }
  const majority = Math.floor(performanceRuns.length / 2) + 1;
  for (const { finding, count } of perfOnly.values()) {
    if (count >= majority) findings.push(finding);
  }
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return {
    measurement: {
      scores: { ...scores, performance: medianScore(performanceRuns) },
      failingAudits: findings,
    },
    performanceRuns,
  };
}
