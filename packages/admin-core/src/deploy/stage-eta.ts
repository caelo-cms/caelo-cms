// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1288 — the phase of a Stage run and an estimate of the time it
 * still needs, from what the run and the recent successful Stages
 * recorded. Pure: `deploy.stage_status` passes in the rows and the
 * database's clock.
 *
 * A run goes `prepare` → `generator` (the only step with page progress) →
 * the publish steps (`lock-wait`, `publish`, `verify-served`, `parity`,
 * `select-preview`, `finish`). The estimate picks its basis:
 * - building, with two progress writes apart in time: `this_run_rate` —
 *   the pages still to build at this run's pace, plus the median publish
 *   time of the recent successful Stages (when one recorded it);
 * - before that, or while publishing: `last_successful_run` — the median
 *   of the recent successful Stages, minus what this run already spent;
 * - otherwise no estimate, with the reason (CLAUDE.md §2: no default
 *   number stands in for a measurement).
 */

import {
  formatStageDuration,
  type PhaseTiming,
  type StageEta,
  type StagePhase,
} from "@caelo-cms/shared";

/**
 * What the generator's progress callback stored on the run
 * (`deploy.update_progress`): the counts, the database time of the newest
 * write, and the time and count of the first one.
 */
export interface StageProgress {
  readonly pagesDone: number;
  readonly pagesTotal: number;
  readonly at?: string;
  readonly firstAt?: string;
  readonly firstDone?: number;
}

/** The run fields the estimate reads. */
export interface StageRunTiming {
  readonly status: "pending" | "running" | "succeeded" | "failed";
  readonly startedAt: string;
  readonly progress: StageProgress | null;
}

/** The top-level steps of a run (a dotted name is a breakdown of one, see 0346). */
function topLevel(phases: readonly PhaseTiming[]): PhaseTiming[] {
  return phases.filter((p) => !p.phase.includes("."));
}

/** The step a failed run stopped in: its last recorded step that is not the catch-all. */
export function failedPhaseOf(phases: readonly PhaseTiming[] | null): string | null {
  if (!phases) return null;
  const steps = topLevel(phases).filter((p) => p.phase !== "failed-step");
  return steps.at(-1)?.phase ?? null;
}

/** Where a run is. */
export function stagePhaseOf(run: StageRunTiming): StagePhase {
  if (run.status === "pending") return "queued";
  if (run.status === "succeeded") return "succeeded";
  if (run.status === "failed") return "failed";
  if (!run.progress) return "preparing";
  return run.progress.pagesDone >= run.progress.pagesTotal ? "publishing" : "building";
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** Total and post-generator (publish) time of one successful run, from its top-level steps. */
function splitRun(phases: readonly PhaseTiming[]): { total: number; publish: number | null } {
  const steps = topLevel(phases);
  const total = steps.reduce((sum, p) => sum + p.ms, 0);
  const gen = steps.findIndex((p) => p.phase === "generator");
  const publish = gen === -1 ? null : steps.slice(gen + 1).reduce((sum, p) => sum + p.ms, 0);
  return { total, publish };
}

/** The estimate, or why there is none. Finished runs get neither. */
export type StageEtaResult =
  | { readonly eta: StageEta; readonly etaUnavailable: null }
  | { readonly eta: null; readonly etaUnavailable: string | null };

/**
 * Estimate the time a Stage run still needs.
 *
 * @param history the top-level step timings of recent successful Stages, newest first
 * @param nowMs the database's clock, so it matches `startedAt` and the progress times
 */
export function estimateStageEta(
  run: StageRunTiming,
  history: readonly (readonly PhaseTiming[])[],
  nowMs: number,
): StageEtaResult {
  const phase = stagePhaseOf(run);
  if (phase === "succeeded" || phase === "failed") return { eta: null, etaUnavailable: null };
  const runs = history.map(splitRun).filter((r) => r.total > 0);
  const medianTotal = median(runs.map((r) => r.total));
  const medianPublish = median(runs.flatMap((r) => (r.publish === null ? [] : [r.publish])));
  const elapsed = Math.max(0, nowMs - Date.parse(run.startedAt));
  const noHistory = "no successful Stage has recorded its step times yet";

  const fromHistory = (spent: number, expected: number | null, what: string): StageEtaResult => {
    if (expected === null) return { eta: null, etaUnavailable: noHistory };
    const remaining = expected - spent;
    if (remaining <= 0) {
      return {
        eta: null,
        etaUnavailable: `${what} has taken longer than in recent successful Stages (about ${formatStageDuration(expected)} there)`,
      };
    }
    return {
      eta: { remainingMs: remaining, basis: "last_successful_run", includesPublish: true },
      etaUnavailable: null,
    };
  };

  if (phase === "queued" || phase === "preparing")
    return fromHistory(elapsed, medianTotal, "this run");

  const p = run.progress as StageProgress;
  if (phase === "publishing") {
    const since = p.at ? Date.parse(p.at) : Number.NaN;
    if (Number.isNaN(since))
      return { eta: null, etaUnavailable: "the build did not record when its pages finished" };
    return fromHistory(Math.max(0, nowMs - since), medianPublish, "publishing");
  }

  // Building: this run's own pace once two progress writes lie apart in time.
  const firstAt = p.firstAt ? Date.parse(p.firstAt) : Number.NaN;
  const at = p.at ? Date.parse(p.at) : Number.NaN;
  const built = p.pagesDone - (p.firstDone ?? p.pagesDone);
  if (!Number.isNaN(firstAt) && !Number.isNaN(at) && at > firstAt && built > 0) {
    const msPerPage = (at - firstAt) / built;
    const pagesLeft = Math.max(0, p.pagesTotal - p.pagesDone);
    // The time since the newest write is already part of building the next pages.
    const pagesMs = Math.max(0, Math.round(pagesLeft * msPerPage - (nowMs - at)));
    return {
      eta: {
        remainingMs: pagesMs + (medianPublish ?? 0),
        basis: "this_run_rate",
        includesPublish: medianPublish !== null,
      },
      etaUnavailable: null,
    };
  }
  return fromHistory(elapsed, medianTotal, "this run");
}
