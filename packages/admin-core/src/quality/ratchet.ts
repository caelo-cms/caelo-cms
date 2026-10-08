// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the quality ratchet. Pure functions only: the audit worker
 * feeds them the Lighthouse result of one page plus that page's stored
 * baselines and accepted findings, and persists what comes back.
 *
 * The rules (maintainer decisions on #553):
 * - Baseline: per page and category, the last accepted score. A page that
 *   has never been audited starts at 100 in every category.
 * - Problem (a): a Lighthouse audit that fails now and is not in the page's
 *   accepted findings.
 * - Problem (b): a category score below the baseline. Accessibility, Best
 *   Practices and SEO are deterministic and trigger immediately.
 * - Performance noise guard: Performance is the median of several runs and
 *   still jitters, so a drop below the baseline only counts once it was
 *   seen in two consecutive audits of the page. The same guard holds back
 *   findings that only belong to the Performance category, so a flaky
 *   "reduce unused JS" does not start a fix loop on an unchanged page.
 * - Ratchet: a score above the baseline raises the baseline automatically.
 *   Lowering it is only possible through an explicit acceptance, which
 *   writes the accepted score as the new baseline (not done here).
 */

/** The four Lighthouse categories the gate audits, in report order. */
export const QUALITY_CATEGORIES = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
] as const;

export type QualityCategory = (typeof QUALITY_CATEGORIES)[number];

/** Initial baseline of every page and category (the target is 100). */
export const INITIAL_BASELINE = 100;

/** Consecutive below-baseline Performance audits needed before the drop
 *  counts as a problem (the noise guard). */
export const PERFORMANCE_DROP_STREAK = 2;

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
  /** Why it failed, e.g. the measured contrast ratio and the colours. */
  readonly explanation?: string;
}

/** The measured state of one page in one audit. Scores are 0..100. */
export interface PageMeasurement {
  readonly scores: Readonly<Record<QualityCategory, number>>;
  readonly failingAudits: readonly FailingAudit[];
}

/** Stored ratchet state of one page and category. */
export interface BaselineState {
  readonly baseline: number;
  /** Consecutive audits whose score was below `baseline` (Performance
   *  only; always 0 for the deterministic categories). */
  readonly belowStreak: number;
}

export type QualityProblem =
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
      readonly kind: "score_below_baseline";
      readonly category: QualityCategory;
      readonly score: number;
      readonly baseline: number;
    };

/** A Performance signal the noise guard is holding back this time. It
 *  becomes a problem if the next audit of the page shows it again. */
export type HeldBackSignal =
  | { readonly kind: "performance_drop"; readonly score: number; readonly baseline: number }
  | { readonly kind: "performance_finding"; readonly auditId: string; readonly title: string };

export interface PageEvaluation {
  readonly problems: readonly QualityProblem[];
  readonly heldBack: readonly HeldBackSignal[];
  /** Baselines to persist for the page after this audit. */
  readonly nextBaselines: Readonly<Record<QualityCategory, BaselineState>>;
}

/** Baseline state for a category the page has none stored for yet. */
export function initialBaselineState(): BaselineState {
  return { baseline: INITIAL_BASELINE, belowStreak: 0 };
}

/**
 * Evaluate one page's audit against its ratchet state.
 *
 * @param measurement - this audit's scores (Performance already the median)
 *   and failing audits.
 * @param baselines - stored state per category; missing categories start
 *   at the initial baseline.
 * @param acceptedAuditIds - Lighthouse audit ids the editors accepted on
 *   THIS page. An acceptance never applies to another page.
 * @param previousHeldBackFindings - Performance-only audit ids the previous
 *   audit of this page held back (second half of the noise guard).
 */
export function evaluatePage(args: {
  readonly measurement: PageMeasurement;
  readonly baselines: Partial<Readonly<Record<QualityCategory, BaselineState>>>;
  readonly acceptedAuditIds: ReadonlySet<string>;
  readonly previousHeldBackFindings: ReadonlySet<string>;
}): PageEvaluation {
  const problems: QualityProblem[] = [];
  const heldBack: HeldBackSignal[] = [];
  const nextBaselines = {} as Record<QualityCategory, BaselineState>;

  for (const category of QUALITY_CATEGORIES) {
    const state = args.baselines[category] ?? initialBaselineState();
    const score = args.measurement.scores[category];
    if (score >= state.baseline) {
      // At or above the baseline: the ratchet only ever moves up here.
      nextBaselines[category] = { baseline: score, belowStreak: 0 };
      continue;
    }
    if (category !== "performance") {
      problems.push({ kind: "score_below_baseline", category, score, baseline: state.baseline });
      nextBaselines[category] = { baseline: state.baseline, belowStreak: 0 };
      continue;
    }
    const streak = state.belowStreak + 1;
    nextBaselines[category] = { baseline: state.baseline, belowStreak: streak };
    if (streak >= PERFORMANCE_DROP_STREAK) {
      problems.push({ kind: "score_below_baseline", category, score, baseline: state.baseline });
    } else {
      heldBack.push({ kind: "performance_drop", score, baseline: state.baseline });
    }
  }

  for (const audit of args.measurement.failingAudits) {
    if (args.acceptedAuditIds.has(audit.id)) continue;
    const performanceOnly =
      audit.categories.length > 0 && audit.categories.every((c) => c === "performance");
    if (performanceOnly && !args.previousHeldBackFindings.has(audit.id)) {
      heldBack.push({ kind: "performance_finding", auditId: audit.id, title: audit.title });
      continue;
    }
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

  return { problems, heldBack, nextBaselines };
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
