// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1288 — where a Stage's build stands, in one shape for every
 * surface: the `deploy.stage_status` op returns it, the `get_stage_status`
 * AI / MCP tool and the "still running" answers of `stage_changes` and
 * `get_quality_audit` print it, and Settings → Deployments and the Live
 * Edit Staging menu show it.
 *
 * The time left is an estimate with its basis named, never a default
 * number (CLAUDE.md §2): `eta` is null with `etaUnavailable` saying why
 * when nothing measured supports one.
 */

import { z } from "zod";

/** Where a Stage run is: waiting, its three steps, or its end. */
export const stagePhaseSchema = z.enum([
  "queued",
  "preparing",
  "building",
  "publishing",
  "succeeded",
  "failed",
]);
export type StagePhase = z.infer<typeof stagePhaseSchema>;

/**
 * What an estimate of the time left rests on:
 * - `this_run_rate`: the pages per second this run has built so far;
 * - `last_successful_run`: how long the recent successful Stages took.
 */
export const stageEtaBasisSchema = z.enum(["this_run_rate", "last_successful_run"]);
export type StageEtaBasis = z.infer<typeof stageEtaBasisSchema>;

/** An estimate of the time a running Stage still needs. */
export const stageEtaSchema = z.object({
  remainingMs: z.number().int().nonnegative(),
  basis: stageEtaBasisSchema,
  /** False when no successful Stage recorded how long publishing takes: the estimate covers the pages only. */
  includesPublish: z.boolean(),
});
export type StageEta = z.infer<typeof stageEtaSchema>;

/** One Stage run (a staging site build) as every status surface shows it. */
export const stageStatusRunSchema = z.object({
  runId: z.string(),
  targetName: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  phase: stagePhaseSchema,
  pagesDone: z.number().int().nonnegative().nullable(),
  pagesTotal: z.number().int().nonnegative().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Run time so far (running) or in total (finished). */
  elapsedMs: z.number().int().nonnegative(),
  /** The failure reason of a failed run. */
  error: z.string().nullable(),
  /** The step a failed run stopped in (`generator`, `publish` …), when recorded. */
  failedPhase: z.string().nullable(),
  eta: stageEtaSchema.nullable(),
  /** Why there is no estimate for a queued or running run; null otherwise. */
  etaUnavailable: z.string().nullable(),
});
export type StageStatusRun = z.infer<typeof stageStatusRunSchema>;

/** A duration for people: "45 s", "1 min 40 s", "12 min". */
export function formatStageDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  const rest = s % 60;
  if (min >= 10 || rest === 0) return `${min} min`;
  return `${min} min ${rest} s`;
}

const BASIS_TEXT: Record<StageEtaBasis, string> = {
  this_run_rate: "from this run's pace",
  last_successful_run: "from recent successful Stages",
};

/** "about 1 min 40 s left (from this run's pace)", or why there is no estimate. */
export function describeStageEta(run: Pick<StageStatusRun, "eta" | "etaUnavailable">): string {
  if (run.eta) {
    const pagesOnly = run.eta.includesPublish ? "" : ", pages only — publishing time unknown";
    return `about ${formatStageDuration(run.eta.remainingMs)} left (${BASIS_TEXT[run.eta.basis]}${pagesOnly})`;
  }
  return `no estimate: ${run.etaUnavailable ?? "nothing measured yet"}`;
}

/**
 * One line for people and the AI, e.g. "Building pages 812 of 1,904 —
 * about 1 min 40 s left (from this run's pace)" or "Failed in generator
 * after 1 min 34 s: <reason>".
 */
export function describeStageRun(run: StageStatusRun): string {
  const n = (v: number) => v.toLocaleString("en-US");
  switch (run.phase) {
    case "queued":
      return `Queued — ${describeStageEta(run)}`;
    case "preparing":
      return `Preparing the build (${formatStageDuration(run.elapsedMs)} so far) — ${describeStageEta(run)}`;
    case "building":
      return `Building pages ${n(run.pagesDone ?? 0)} of ${n(run.pagesTotal ?? 0)} — ${describeStageEta(run)}`;
    case "publishing":
      return `All ${n(run.pagesTotal ?? 0)} pages built, publishing to staging — ${describeStageEta(run)}`;
    case "succeeded":
      return `Succeeded in ${formatStageDuration(run.elapsedMs)}${run.pagesTotal === null ? "" : ` (${n(run.pagesTotal)} pages)`}`;
    case "failed":
      return `Failed${run.failedPhase ? ` in ${run.failedPhase}` : ""} after ${formatStageDuration(run.elapsedMs)}: ${run.error ?? "no reason recorded"}`;
  }
}
