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
  type FlaggedElement,
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
        /** Table/list details; `items[].node` describes a flagged element. */
        readonly details?: { readonly items?: readonly unknown[] };
      }
    >
  >;
}

/** Flagged elements reported per finding (enough to locate the module). */
const MAX_FLAGGED_ELEMENTS = 5;
const MAX_ELEMENT_TEXT = 300;

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, MAX_ELEMENT_TEXT) : undefined;
}

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

/** The elements (or console entries) an audit flagged, read from its details. */
function flaggedElements(
  details: { readonly items?: readonly unknown[] } | undefined,
): FlaggedElement[] {
  const out: FlaggedElement[] = [];
  for (const item of details?.items ?? []) {
    if (out.length >= MAX_FLAGGED_ELEMENTS) break;
    if (item === null || typeof item !== "object") continue;
    const node = (item as { node?: unknown }).node;
    if (node === null || typeof node !== "object") {
      const entry = consoleEntry(item as Record<string, unknown>);
      if (entry) out.push(entry);
      continue;
    }
    const n = node as Record<string, unknown>;
    const element: FlaggedElement = {
      ...(nonEmpty(n.selector) ? { selector: nonEmpty(n.selector) } : {}),
      ...(nonEmpty(n.snippet) ? { snippet: nonEmpty(n.snippet) } : {}),
      ...(nonEmpty(n.nodeLabel) ? { label: nonEmpty(n.nodeLabel) } : {}),
      ...(nonEmpty(n.explanation) ? { explanation: nonEmpty(n.explanation) } : {}),
    };
    if (Object.keys(element).length > 0) out.push(element);
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

/** Lighthouse's own pass threshold (report-utils `showAsPassed`). */
const PASS_MIN_SCORE = 0.9;

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
    if (audit.score >= PASS_MIN_SCORE) continue;
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
