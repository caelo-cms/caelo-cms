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

import { performanceMetricsFromRuns } from "./lighthouse-metrics.js";
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
 * @throws when there is no run (an infrastructure failure, never a score).
 */
export function bestRunIndex(
  performanceScores: readonly number[],
  perfOnlyFailures: readonly number[],
): number {
  if (performanceScores.length === 0) throw new Error("bestRunIndex: no Performance runs");
  let best = 0;
  for (let i = 1; i < performanceScores.length; i += 1) {
    const score = performanceScores[i] as number;
    const bestScore = performanceScores[best] as number;
    if (
      score > bestScore ||
      (score === bestScore && (perfOnlyFailures[i] ?? 0) < (perfOnlyFailures[best] ?? 0))
    ) {
      best = i;
    }
  }
  return best;
}

/**
 * Combine one full run (all four categories) and the extra Performance
 * runs into the page's measurement.
 *
 * - Performance score, Performance-only findings and Performance metrics
 *   (FCP, LCP, TBT, CLS, SI) all come from the best run (`bestRunIndex`),
 *   so the score, its findings and its metrics describe the same run.
 *   Metrics stay data next to the scores, never findings
 *   (lighthouse-metrics.ts); each metric keeps every run's value.
 * - Accessibility, Best Practices, SEO and every finding that belongs to
 *   one of them: the full run (deterministic).
 *
 * @returns the measurement plus every Performance score, for the record.
 */
export function measurementFromRuns(
  fullRun: LhrLike,
  extraPerformanceRuns: readonly LhrLike[],
): { measurement: PageMeasurement; performanceRuns: number[] } {
  const scores = categoryScores(fullRun, QUALITY_CATEGORIES);
  const runs = [fullRun, ...extraPerformanceRuns];
  const performanceRuns = [
    scores.performance,
    ...extraPerformanceRuns.map((r) => categoryScores(r, ["performance"]).performance),
  ];
  const isPerformanceOnly = (f: FailingAudit) => f.categories.every((c) => c === "performance");
  const perfOnlyByRun = runs.map((r) => failingAudits(r).filter(isPerformanceOnly));
  const best = bestRunIndex(
    performanceRuns,
    perfOnlyByRun.map((f) => f.length),
  );
  const findings = [
    ...failingAudits(fullRun).filter((f) => !isPerformanceOnly(f)),
    ...(perfOnlyByRun[best] ?? []),
  ].sort((a, b) => a.id.localeCompare(b.id));
  return {
    measurement: {
      scores: { ...scores, performance: performanceRuns[best] as number },
      failingAudits: findings,
      metrics: performanceMetricsFromRuns(runs, best),
    },
    performanceRuns,
  };
}
