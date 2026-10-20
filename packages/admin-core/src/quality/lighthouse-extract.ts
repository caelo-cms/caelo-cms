// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — reduce Lighthouse results (LHRs) to the compact
 * `PageMeasurement` the gate evaluates (ratchet.ts). Pure; runs inside the audit
 * child process so the multi-megabyte LHR never crosses the process
 * boundary.
 *
 * Lighthouse is loaded dynamically (no static types), so the LHR shape is
 * typed here with only the fields we read.
 */

import { combineRunMetrics, type RunMetrics, runMetrics } from "./lighthouse-metrics.js";
import { elementFromNode, nonEmpty } from "./lighthouse-node.js";
import {
  type FailingAudit,
  type FlaggedElement,
  type PageMeasurement,
  QUALITY_CATEGORIES,
  type QualityCategory,
} from "./ratchet.js";

/** The subset of a Lighthouse result this module reads. */
export interface LhrLike {
  readonly requestedUrl?: string;
  readonly finalDisplayedUrl?: string;
  readonly runtimeError?: { readonly code: string; readonly message: string };
  /** The settings the run used; the CPU calibration checks its throttling. */
  readonly configSettings?: {
    readonly throttling?: { readonly cpuSlowdownMultiplier?: number };
  };
  readonly categories: Readonly<
    Record<
      string,
      {
        readonly score: number | null;
        readonly auditRefs: readonly {
          readonly id: string;
          readonly group?: string;
          /** Lighthouse's scoring weight (0 for not-applicable audits). */
          readonly weight?: number;
        }[];
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
        /** A metric's raw value (Performance metrics, lighthouse-metrics.ts). */
        readonly numericValue?: number;
        readonly numericUnit?: string;
        /** Set when `scoreDisplayMode` is `error`. */
        readonly errorMessage?: string;
        /** Table/list details; `items[].node` describes a flagged element. */
        readonly details?: { readonly items?: readonly unknown[] };
      }
    >
  >;
}

/** Flagged elements reported per finding (enough to locate the module).
 *  A longer list keeps this many plus one truncation marker, so a
 *  finding carries at most `MAX_FLAGGED_ELEMENTS + 1` entries. */
export const MAX_FLAGGED_ELEMENTS = 5;

/** Label prefix of the marker appended when an audit flagged more items
 *  than are kept (#667). */
export const TRUNCATED_ELEMENTS_PREFIX = "+";
/** Label suffix of that marker. */
export const TRUNCATED_ELEMENTS_SUFFIX = " more flagged item(s) not shown";

/**
 * A console / network entry (`errors-in-console`): the message and the URL
 * it came from. Without these an `errors-in-console` finding names no
 * cause, and the fix is a guess — in the homepage real-AI run of PR #641
 * the AI blamed a plugin's runtime for what was a `/favicon.ico` 404 and
 * built a cookie banner to "fix" it.
 */
function consoleEntry(item: Record<string, unknown>): FlaggedElement | null {
  const description = nonEmpty(item.description);
  if (!description) return null;
  const location = item.sourceLocation as { url?: unknown } | null | undefined;
  const url = nonEmpty(location?.url) ?? nonEmpty(item.url);
  const source = nonEmpty(item.source);
  return {
    explanation: source ? `${source}: ${description}` : description,
    ...(url ? { url } : {}),
  };
}

/**
 * #667 — a flagged resource or reason without a DOM node: the URL a
 * caching / compression audit names, or the reason a back/forward-cache
 * restore failed. Without them the AI could not tell Caelo's own files and
 * hosting from a module's third-party embed or script, and guessed.
 */
function resourceEntry(item: Record<string, unknown>): FlaggedElement | null {
  const url = nonEmpty(item.url);
  const reason = nonEmpty(item.reason);
  if (!url && !reason) return null;
  return { ...(reason ? { explanation: reason } : {}), ...(url ? { url } : {}) };
}

/** The elements (or console entries) an audit flagged, read from its details. */
function flaggedElements(
  details: { readonly items?: readonly unknown[] } | undefined,
): FlaggedElement[] {
  const out: FlaggedElement[] = [];
  const items = details?.items ?? [];
  for (const [index, item] of items.entries()) {
    if (out.length >= MAX_FLAGGED_ELEMENTS) {
      // #667 — say the list is a sample: ownership (platform vs site) must
      // never be decided from the first few items alone.
      out.push({
        label: `${TRUNCATED_ELEMENTS_PREFIX}${items.length - index}${TRUNCATED_ELEMENTS_SUFFIX}`,
      });
      break;
    }
    if (item === null || typeof item !== "object") continue;
    const node = (item as { node?: unknown }).node;
    if (node === null || typeof node !== "object") {
      const entry =
        consoleEntry(item as Record<string, unknown>) ??
        resourceEntry(item as Record<string, unknown>);
      if (entry) out.push(entry);
      continue;
    }
    const element = elementFromNode(node);
    if (element) out.push(element);
  }
  return out;
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

/**
 * A scored audit passes only at a perfect score (#727, "optimum, not good
 * enough"): every audit below 1 is a finding. Lighthouse's own report shows
 * audits at >= 0.9 as passed; the gate deliberately does not — a 0.9 is
 * work left on the table, and the AI is asked to finish it.
 */
const PASS_SCORE = 1;

/** Score display modes that can fail. `informative`, `manual`,
 *  `notApplicable` and `error` never count as findings. */
const SCORED_MODES = new Set(["binary", "numeric", "metricSavings"]);

/** Audit groups that never become findings: hidden audits, and the
 *  Performance metrics (FCP, LCP, TBT, CLS, SI), which the category score
 *  already measures. */
const NON_FINDING_GROUPS = new Set(["hidden", "metrics"]);

/**
 * Audits that measure staging itself, not the page. Staging is `noindex`
 * by design (CLAUDE.md §2: X-Robots-Tag + robots.txt), so `is-crawlable`
 * fails on every staged page; production gets its own robots semantics at
 * promote (#561). Exempt audits are neither findings nor part of the
 * category score: the score is recomputed without them, the way Lighthouse
 * scores a category (weighted mean, 2 decimals).
 */
export const STAGING_EXEMPT_AUDITS: ReadonlySet<string> = new Set(["is-crawlable"]);

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
    const score = stagingCategoryScore(lhr, c);
    if (score === null) {
      throw new LighthouseRunError(
        "CATEGORY_UNSCORED",
        `Lighthouse returned no ${c} score for ${lhr.requestedUrl ?? "the page"}`,
      );
    }
    out[c] = Math.round(score * 100);
  }
  return out;
}

/** A category's 0..1 score with the staging-exempt audits taken out;
 *  null when Lighthouse could not score it. */
function stagingCategoryScore(lhr: LhrLike, category: QualityCategory): number | null {
  const cat = lhr.categories[category];
  if (!cat || cat.score === null) return null;
  const refs = cat.auditRefs.filter((r) => (r.weight ?? 0) > 0);
  if (!refs.some((r) => STAGING_EXEMPT_AUDITS.has(r.id))) return cat.score;
  let sum = 0;
  let weight = 0;
  for (const ref of refs) {
    if (STAGING_EXEMPT_AUDITS.has(ref.id)) continue;
    const audit = lhr.audits[ref.id];
    if (!audit || audit.score === null) return null;
    sum += audit.score * (ref.weight ?? 0);
    weight += ref.weight ?? 0;
  }
  return weight === 0 ? 1 : Math.round((sum / weight) * 100) / 100;
}

/** Failing audits of one run, with the gated categories that reference
 *  each (ordered by audit id for stable output). */
export function failingAudits(lhr: LhrLike): FailingAudit[] {
  assertUsable(lhr);
  const categoriesOf = new Map<string, QualityCategory[]>();
  for (const category of QUALITY_CATEGORIES) {
    for (const ref of lhr.categories[category]?.auditRefs ?? []) {
      if (ref.group !== undefined && NON_FINDING_GROUPS.has(ref.group)) continue;
      if (STAGING_EXEMPT_AUDITS.has(ref.id)) continue;
      const list = categoriesOf.get(ref.id) ?? [];
      list.push(category);
      categoriesOf.set(ref.id, list);
    }
  }
  const out: FailingAudit[] = [];
  for (const [id, categories] of categoriesOf) {
    const audit = lhr.audits[id];
    if (!audit || audit.score === null || !SCORED_MODES.has(audit.scoreDisplayMode)) continue;
    if (audit.score >= PASS_SCORE) continue;
    const elements = flaggedElements(audit.details);
    out.push({
      id,
      title: audit.title,
      score: audit.score,
      categories,
      ...(audit.displayValue ? { displayValue: audit.displayValue } : {}),
      ...(elements.length > 0 ? { elements } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The index of a page's best Performance run: the highest Performance
 * score, then the fewest failing Performance-only audits, then the
 * earliest run.
 *
 * Why the best run and not the median (#874): Lighthouse simulates the CPU
 * slowdown by multiplying every observed task by the calibrated factor, so
 * a few ms of interference on the audit host become tens of ms on the
 * target device, and Total Blocking Time (only the part of a task above
 * 50 ms counts) turns that into 0 ms in one run and 400 ms in the next.
 * Interference only ever slows a run down, never speeds it up, so the
 * fastest run is the closest measurement of the page itself. The median of
 * such a bimodal set lands on either side at random (#837: byte-identical
 * pages moved 100 → 99 and 99 → 89 between two audits).
 *
 * @param performanceScores - each run's 0..100 Performance score, in run order.
 * @param perfOnlyFailures - each run's count of failing Performance-only audits.
 * @throws when there is no run (an infrastructure failure, never a score)
 *   or the two lists do not describe the same runs.
 */
export function bestRunIndex(
  performanceScores: readonly number[],
  perfOnlyFailures: readonly number[],
): number {
  if (performanceScores.length === 0) throw new Error("bestRunIndex: no Performance runs");
  if (perfOnlyFailures.length !== performanceScores.length) {
    throw new Error(
      `bestRunIndex: ${performanceScores.length} Performance score(s) but ${perfOnlyFailures.length} finding count(s); both must list every run`,
    );
  }
  let best = 0;
  for (let i = 1; i < performanceScores.length; i += 1) {
    const score = performanceScores[i] as number;
    const bestScore = performanceScores[best] as number;
    const fewerFindings = (perfOnlyFailures[i] as number) < (perfOnlyFailures[best] as number);
    if (score > bestScore || (score === bestScore && fewerFindings)) best = i;
  }
  return best;
}

/**
 * One Lighthouse run reduced to what the page's measurement needs. The audit
 * child (or a parallel audit task, #875) reduces each run where it ran, so
 * the multi-megabyte LHR never crosses a process or machine boundary.
 */
export interface RunMeasurement {
  /** 0..100 per category the run audited: all four for the full run,
   *  Performance alone for the extra runs. */
  readonly scores: Partial<Record<QualityCategory, number>>;
  /** The run's failing audits (`failingAudits`). */
  readonly failingAudits: readonly FailingAudit[];
  /**
   * Every audit the run's non-Performance categories reference, failing or
   * not. Empty for a Performance-only run. `combineRuns` reads it from the
   * full run to tell which audits belong only to Performance: an extra run
   * carries the Performance category alone, so an audit Performance shares
   * with another category looks Performance-only there.
   */
  readonly otherCategoryAuditIds: readonly string[];
  readonly metrics: RunMetrics;
  /** Where the run ended up after redirects. */
  readonly finalUrl?: string;
  /** The CPU calibration of the host the run ran on (cpu-calibration.ts). */
  readonly cpuCalibration?: {
    readonly benchmarkIndex: number;
    readonly cpuSlowdownMultiplier: number;
  };
}

/**
 * Reduce one run. The full run audits every category; extra runs only
 * Performance.
 *
 * @throws LighthouseRunError when the run produced no usable result or a
 *   requested category has no score.
 */
export function reduceRun(
  lhr: LhrLike,
  categories: readonly QualityCategory[],
  cpuCalibration?: RunMeasurement["cpuCalibration"],
): RunMeasurement {
  return {
    scores: categoryScores(lhr, categories),
    failingAudits: failingAudits(lhr),
    otherCategoryAuditIds: [
      ...new Set(
        categories
          .filter((c) => c !== "performance")
          .flatMap((c) => (lhr.categories[c]?.auditRefs ?? []).map((r) => r.id)),
      ),
    ].sort(),
    metrics: runMetrics(lhr),
    ...(lhr.finalDisplayedUrl ? { finalUrl: lhr.finalDisplayedUrl } : {}),
    ...(cpuCalibration ? { cpuCalibration } : {}),
  };
}

/**
 * Combine the reduced runs of one page into its measurement. `runs[0]` is
 * the full run (all four categories), the rest are Performance runs.
 *
 * - Performance score, Performance-only findings and Performance metrics
 *   (FCP, LCP, TBT, CLS, SI) all come from the best run (`bestRunIndex`),
 *   so the score, its findings and its metrics describe the same run, and
 *   the CPU calibration shown is that run's host. Metrics stay data next
 *   to the scores, never findings (lighthouse-metrics.ts); each metric
 *   keeps every run's value.
 * - Accessibility, Best Practices, SEO and every finding that belongs to
 *   one of them: the full run (deterministic).
 *
 * @returns the measurement plus every Performance score, for the record.
 * @throws when the full run lacks a category score or any run lacks its
 *   Performance score (a reduction bug, never a measurement).
 */
export function combineRuns(runs: readonly RunMeasurement[]): {
  measurement: PageMeasurement;
  performanceRuns: number[];
} {
  const full = runs[0];
  if (!full) throw new Error("combineRuns: no Lighthouse runs");
  const scores = {} as Record<QualityCategory, number>;
  for (const c of QUALITY_CATEGORIES) {
    const score = full.scores[c];
    if (score === undefined) throw new Error(`combineRuns: the full run has no ${c} score`);
    scores[c] = score;
  }
  const performanceRuns = runs.map((r, i) => {
    const score = r.scores.performance;
    if (score === undefined) throw new Error(`combineRuns: run ${i + 1} has no Performance score`);
    return score;
  });
  // Which audits belong only to Performance is read from the full run
  // (`otherCategoryAuditIds`): an audit shared with another category would
  // otherwise look Performance-only in an extra run and be listed twice, or
  // with the wrong categories when it fails in the best run alone.
  const sharedWithOtherCategories = new Set(full.otherCategoryAuditIds);
  const isPerformanceOnly = (f: FailingAudit) =>
    !sharedWithOtherCategories.has(f.id) && f.categories.every((c) => c === "performance");
  const perfOnlyByRun = runs.map((r) => r.failingAudits.filter(isPerformanceOnly));
  const best = bestRunIndex(
    performanceRuns,
    perfOnlyByRun.map((f) => f.length),
  );
  const findings = [
    ...full.failingAudits.filter((f) => !isPerformanceOnly(f)),
    ...(perfOnlyByRun[best] as FailingAudit[]),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const calibration = runs[best]?.cpuCalibration;
  return {
    measurement: {
      scores: { ...scores, performance: performanceRuns[best] as number },
      failingAudits: findings,
      metrics: {
        ...combineRunMetrics(
          runs.map((r) => r.metrics),
          best,
        ),
        ...(calibration ? { cpuCalibration: calibration } : {}),
      },
    },
    performanceRuns,
  };
}

/**
 * Combine one full run (all four categories) and the extra Performance
 * runs of the same host into the page's measurement (`combineRuns` over
 * `reduceRun` of each).
 *
 * @returns the measurement plus every Performance score, for the record.
 */
export function measurementFromRuns(
  fullRun: LhrLike,
  extraPerformanceRuns: readonly LhrLike[],
): { measurement: PageMeasurement; performanceRuns: number[] } {
  return combineRuns([
    reduceRun(fullRun, QUALITY_CATEGORIES),
    ...extraPerformanceRuns.map((r) => reduceRun(r, ["performance"])),
  ]);
}
