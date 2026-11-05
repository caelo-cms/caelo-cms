// SPDX-License-Identifier: MPL-2.0

/**
 * The Lighthouse Performance metrics of one page (FCP, LCP, TBT, CLS,
 * Speed Index), with the LCP element, the LCP breakdown and the layout
 * shifts that locate a slow or shifting page's cause.
 *
 * Metrics are DATA, not findings: the gate does not evaluate them (the
 * Performance category score already measures them, see
 * `NON_FINDING_GROUPS` in lighthouse-extract.ts). They exist so the AI or
 * an external MCP agent making a page faster can see WHICH metric is bad
 * and which element causes it, instead of guessing — or running Lighthouse
 * itself against a URL that is not the staged build.
 *
 * Every value comes from the page's SCORING run (`scoringRun`,
 * run-selection.ts: the best run when the runs agree, the median run when
 * they disagree, #874/#1370), the same run the Performance score and the
 * Performance-only findings come from, so the three always agree.
 * `runValues` keeps every run's value so the spread stays visible. A
 * metric the scoring run did not measure is null with the reason, never a
 * zero or another run's value. The elements (LCP element, breakdown,
 * layout shifts) come from the scoring run too.
 */

import type { LhrLike } from "./lighthouse-extract.js";
import { elementFromNode, nonEmpty } from "./lighthouse-node.js";
import type { FlaggedElement } from "./ratchet.js";
import type { ScoredBy } from "./run-selection.js";

/** The Performance metrics Lighthouse 13 scores, in report order. */
export const PERFORMANCE_METRICS = [
  {
    id: "first-contentful-paint",
    label: "FCP",
    title: "First Contentful Paint",
    unit: "millisecond",
  },
  {
    id: "largest-contentful-paint",
    label: "LCP",
    title: "Largest Contentful Paint",
    unit: "millisecond",
  },
  { id: "total-blocking-time", label: "TBT", title: "Total Blocking Time", unit: "millisecond" },
  {
    id: "cumulative-layout-shift",
    label: "CLS",
    title: "Cumulative Layout Shift",
    unit: "unitless",
  },
  { id: "speed-index", label: "SI", title: "Speed Index", unit: "millisecond" },
] as const;

type MetricDef = (typeof PERFORMANCE_METRICS)[number];
export type PerformanceMetricId = MetricDef["id"];

/** One metric of one page: the scoring run's value, plus every run's. */
export interface PerformanceMetric {
  readonly id: PerformanceMetricId;
  /** Short name ("LCP"). */
  readonly label: string;
  readonly title: string;
  /** Lighthouse's unit of `numericValue` (`millisecond`, or `unitless` for CLS). */
  readonly numericUnit: "millisecond" | "unitless";
  /** The scoring run's value; null when that run did not measure it (see `unavailableReason`). */
  readonly numericValue: number | null;
  /** The scoring run's value formatted the way Lighthouse shows it ("2.2 s", "120 ms", "0.012"). */
  readonly displayValue: string | null;
  /** The scoring run's 0..1 Lighthouse metric score; null with `numericValue`. */
  readonly score: number | null;
  /** Each run's value, in run order (the full run first); null where a run measured nothing. */
  readonly runValues: readonly (number | null)[];
  /** Why `numericValue` is null; null when it was measured. */
  readonly unavailableReason: string | null;
}

/** One sub-part of the LCP time (Lighthouse's LCP breakdown). */
export interface LcpBreakdownPart {
  /** Lighthouse's id: `timeToFirstByte`, `resourceLoadDelay`, `resourceLoadDuration`, `elementRenderDelay`. */
  readonly subpart: string;
  readonly label: string;
  readonly durationMs: number;
}

/** One layout shift: the element that moved most, and its root causes. */
export interface LayoutShift {
  readonly element: FlaggedElement;
  /** This shift's contribution to CLS. */
  readonly score: number;
  /** Lighthouse's root causes, e.g. "Unsized image element: body > img.hero". */
  readonly causes: readonly string[];
}

/** The Performance metrics of one audited page. */
export interface PerformanceMetrics {
  /** How many Performance runs were taken; the values are the scoring one's. */
  readonly runs: number;
  /** How the scoring run was chosen (run-selection.ts). Absent on audits
   *  recorded before #1370, which were all scored by their best run. */
  readonly scoredBy?: ScoredBy;
  /** Every metric of `PERFORMANCE_METRICS`, in that order. */
  readonly metrics: readonly PerformanceMetric[];
  /** The Largest Contentful Paint element; null when Lighthouse named none. */
  readonly lcpElement: FlaggedElement | null;
  /** Where the LCP time goes; empty when Lighthouse reported no breakdown. */
  readonly lcpBreakdown: readonly LcpBreakdownPart[];
  /** The largest layout shifts (up to five); empty when nothing shifted. */
  readonly layoutShifts: readonly LayoutShift[];
  /** The host's benchmark index and the CPU slowdown calibrated to it
   *  (cpu-calibration.ts); set by the audit child, absent on older audits. */
  readonly cpuCalibration?: {
    readonly benchmarkIndex: number;
    readonly cpuSlowdownMultiplier: number;
    /** The emulated device's benchmark index (cpu-calibration.ts); absent
     *  on audits recorded before #1370. */
    readonly targetBenchmarkIndex?: number;
  };
}

/** Layout shifts kept per page (Lighthouse lists the largest first). */
const MAX_LAYOUT_SHIFTS = 5;
/** Root causes kept per layout shift. */
const MAX_SHIFT_CAUSES = 3;

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * A metric value formatted like Lighthouse's `displayValue`: seconds with
 * one decimal for the paint metrics and Speed Index, milliseconds at 10 ms
 * granularity for TBT, three decimals for CLS.
 */
export function formatMetricValue(id: PerformanceMetricId, value: number): string {
  if (id === "cumulative-layout-shift") return value.toFixed(3);
  if (id === "total-blocking-time") return `${Math.round(value / 10) * 10} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

/** One run's value of a metric, or why it has none. */
export type RunMetricValue =
  | { readonly value: number; readonly score: number }
  | { readonly reason: string };

/**
 * One Lighthouse run reduced to what the page's metrics need: each metric's
 * value (in `PERFORMANCE_METRICS` order) and the elements. A parallel audit
 * task (#875) sends this instead of its multi-megabyte LHR; the admin
 * combines the runs with `combineRunMetrics`.
 */
export interface RunMetrics {
  readonly values: readonly RunMetricValue[];
  readonly lcpElement: FlaggedElement | null;
  readonly lcpBreakdown: readonly LcpBreakdownPart[];
  readonly layoutShifts: readonly LayoutShift[];
}

function runValue(run: LhrLike, def: MetricDef): RunMetricValue {
  const audit = run.audits[def.id];
  if (!audit) return { reason: "Lighthouse returned no such audit" };
  if (audit.scoreDisplayMode === "error") {
    return { reason: audit.errorMessage ?? "the audit errored without a message" };
  }
  if (typeof audit.numericValue !== "number" || !Number.isFinite(audit.numericValue)) {
    return { reason: `no numeric value (score mode ${audit.scoreDisplayMode})` };
  }
  if (audit.numericUnit !== def.unit) {
    return { reason: `unexpected unit '${audit.numericUnit ?? "none"}' (expected ${def.unit})` };
  }
  if (audit.score === null) return { reason: "Lighthouse did not score the value" };
  return { value: audit.numericValue, score: audit.score };
}

function metricOfScoringRun(
  def: MetricDef,
  index: number,
  runs: readonly RunMetrics[],
  scoringIndex: number,
  scoredBy: ScoredBy,
): PerformanceMetric {
  const decimals = def.unit === "unitless" ? 4 : 0;
  const per = runs.map((r) => {
    const v = r.values[index];
    if (!v) throw new Error(`combineRunMetrics: a run carries no ${def.label} entry`);
    return v;
  });
  const runValues = per.map((p) => ("value" in p ? round(p.value, decimals) : null));
  const base = { id: def.id, label: def.label, title: def.title, numericUnit: def.unit, runValues };
  const scoring = per[scoringIndex] as RunMetricValue;
  if ("reason" in scoring) {
    return {
      ...base,
      numericValue: null,
      displayValue: null,
      score: null,
      unavailableReason: `${def.label} was not measured in the ${scoredBy} of ${runs.length} Lighthouse run(s) (run ${scoringIndex + 1}: ${scoring.reason}); no other run's value is reported in its place.`,
    };
  }
  const value = round(scoring.value, decimals);
  return {
    ...base,
    numericValue: value,
    displayValue: formatMetricValue(def.id, value),
    score: round(scoring.score, 2),
    unavailableReason: null,
  };
}

/** The `list` items of an insight's details (tables and nodes). */
function listItems(run: LhrLike, auditId: string): readonly unknown[] {
  const items = run.audits[auditId]?.details?.items;
  return Array.isArray(items) ? (items as readonly unknown[]) : [];
}

/**
 * The LCP element and breakdown. Lighthouse 13 reports both in the
 * `lcp-breakdown-insight` audit (it replaced `largest-contentful-paint-element`):
 * a table of sub-parts and the element's node.
 */
function lcpDetails(run: LhrLike): {
  element: FlaggedElement | null;
  breakdown: LcpBreakdownPart[];
} {
  let element: FlaggedElement | null = null;
  const breakdown: LcpBreakdownPart[] = [];
  for (const item of listItems(run, "lcp-breakdown-insight")) {
    if (item === null || typeof item !== "object") continue;
    const it = item as { type?: unknown; items?: unknown };
    if (it.type === "node") {
      element ??= elementFromNode(item);
      continue;
    }
    if (it.type !== "table" || !Array.isArray(it.items)) continue;
    for (const row of it.items as unknown[]) {
      const r = row as { subpart?: unknown; label?: unknown; duration?: unknown };
      const subpart = nonEmpty(r.subpart);
      if (!subpart || typeof r.duration !== "number" || !Number.isFinite(r.duration)) continue;
      breakdown.push({
        subpart,
        label: nonEmpty(r.label) ?? subpart,
        durationMs: Math.round(r.duration),
      });
    }
  }
  return { element, breakdown };
}

/** The largest layout shifts with their root causes (`layout-shifts` audit). */
function layoutShifts(run: LhrLike): LayoutShift[] {
  const out: LayoutShift[] = [];
  for (const item of listItems(run, "layout-shifts")) {
    if (out.length >= MAX_LAYOUT_SHIFTS) break;
    const row = item as { node?: unknown; score?: unknown; subItems?: { items?: unknown } } | null;
    if (row === null || typeof row !== "object" || typeof row.score !== "number") continue;
    const element = elementFromNode(row.node);
    if (!element) continue;
    const causes: string[] = [];
    const subs = Array.isArray(row.subItems?.items) ? (row.subItems.items as unknown[]) : [];
    for (const sub of subs) {
      if (causes.length >= MAX_SHIFT_CAUSES) break;
      const s = sub as { cause?: unknown; extra?: unknown } | null;
      const cause = nonEmpty(s?.cause);
      if (!cause) continue;
      const culprit = elementFromNode(s?.extra);
      const where =
        culprit?.selector ??
        culprit?.label ??
        nonEmpty((s?.extra as { url?: unknown } | null)?.url);
      causes.push(where ? `${cause}: ${where}` : cause);
    }
    out.push({ element, score: round(row.score, 4), causes });
  }
  return out;
}

/** One Lighthouse run reduced to its metrics and elements (`RunMetrics`). */
export function runMetrics(run: LhrLike): RunMetrics {
  const lcp = lcpDetails(run);
  return {
    values: PERFORMANCE_METRICS.map((def) => runValue(run, def)),
    lcpElement: lcp.element,
    lcpBreakdown: lcp.breakdown,
    layoutShifts: layoutShifts(run),
  };
}

/**
 * The page's Performance metrics from its reduced runs.
 *
 * @param runs - every Performance run of the page, the full run first.
 * @param scoringIndex - the run the Performance score comes from
 *   (`scoringRun`, run-selection.ts).
 * @param scoredBy - how that run was chosen.
 * @throws when `runs` is empty or has no run `scoringIndex`: an audited
 *   page without a Performance run is an infrastructure failure, never a
 *   measurement.
 */
export function combineRunMetrics(
  runs: readonly RunMetrics[],
  scoringIndex: number,
  scoredBy: ScoredBy,
): PerformanceMetrics {
  if (runs.length === 0) throw new Error("combineRunMetrics: no Lighthouse runs");
  const scoring = runs[scoringIndex];
  if (!scoring) throw new Error(`combineRunMetrics: no run ${scoringIndex + 1} of ${runs.length}`);
  return {
    runs: runs.length,
    scoredBy,
    metrics: PERFORMANCE_METRICS.map((def, i) =>
      metricOfScoringRun(def, i, runs, scoringIndex, scoredBy),
    ),
    lcpElement: scoring.lcpElement,
    lcpBreakdown: [...scoring.lcpBreakdown],
    layoutShifts: [...scoring.layoutShifts],
  };
}

/**
 * The page's Performance metrics from its Lighthouse runs, scored by the
 * best run `bestIndex` (`combineRunMetrics` over `runMetrics` of each).
 *
 * @param runs - every Performance run of the page, the full run first.
 * @param bestIndex - the run the Performance score comes from.
 */
export function performanceMetricsFromRuns(
  runs: readonly LhrLike[],
  bestIndex: number,
): PerformanceMetrics {
  return combineRunMetrics(runs.map(runMetrics), bestIndex, "best");
}
