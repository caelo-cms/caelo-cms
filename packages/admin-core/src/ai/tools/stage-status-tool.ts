// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1288 — `get_stage_status`: where a Stage's build stands, with an
 * estimate of the time left, for the chat and for MCP clients.
 *
 * `stage_changes` waits about 60 s; a longer build keeps running on the
 * server. Its "still running" answer and `get_quality_audit`'s point here
 * ({@link stillRunningStageText}), so an agent learns the progress and
 * when asking again is worthwhile instead of re-running the Stage or
 * asking in a loop (CLAUDE.md §11.B: no polling).
 */

import { execute } from "@caelo-cms/query-api";
import { describeStageRun, type ExecutionContext, type StageStatusRun } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import { makeReadTool } from "./_make-read-tool.js";
import type { ToolContext } from "./dispatch.js";

const input = z
  .object({
    deployRunId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "The run `stage_changes` / `get_quality_audit` named. Omit = the newest Stage runs.",
      ),
    limit: z.number().int().min(1).max(20).optional().describe("Default 5."),
  })
  .strict();

/** What to do next for this run: the one follow-up call, when there is one. */
export function stageNextStep(run: StageStatusRun): string {
  const id = run.runId;
  switch (run.status) {
    case "queued":
    case "running":
      return run.eta
        ? `Next: call get_stage_status with deployRunId "${id}" once that time has passed — once, not in a loop. Do NOT call stage_changes again; do not tell the operator it is staged yet.`
        : `Next: call get_stage_status with deployRunId "${id}" again in a minute or two — once, not in a loop. Do NOT call stage_changes again; do not tell the operator it is staged yet.`;
    case "succeeded":
      return `Next: call get_quality_audit with deployRunId "${id}" for its quality check.`;
    case "failed":
      return "Nothing was staged. Fix the cause above, then call stage_changes again.";
  }
}

/**
 * The answer for a Stage that outlasted a tool's wait: where its build
 * stands and the one call to make next. `run` null = no build run yet.
 */
export function stillRunningStageText(runId: string, run: StageStatusRun | null): string {
  if (run === null) {
    return (
      `The Stage is still running on the server: build run ${runId} has not started yet (the Stage is merging the chats' changes). It continues without this call; do NOT call stage_changes again and do not tell the operator it is staged yet. ` +
      `Call get_stage_status with deployRunId "${runId}" in a minute — once, not in a loop; if the run still does not exist then, the Stage stopped before its build: call stage_changes again.`
    );
  }
  if (run.status === "succeeded" || run.status === "failed") {
    return `Stage build run ${runId}: ${describeStageRun(run)}. ${stageNextStep(run)}`;
  }
  return `The Stage is still running on the server (build run ${runId}: ${describeStageRun(run)}). It continues without this call. ${stageNextStep(run)} When it reports the build succeeded, call get_quality_audit with deployRunId "${runId}".`;
}

/** Read one Stage run's status (null when no such Stage build exists yet). */
export async function readStageStatus(
  toolCtx: Pick<ToolContext, "registry" | "adapter">,
  ctx: ExecutionContext,
  runId: string,
): Promise<StageStatusRun | null> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "deploy.stage_status", {
    deployRunId: runId,
  });
  if (!r.ok) throw new Error(`deploy.stage_status failed: ${describeError(r.error)}`);
  return (r.value as { runs: StageStatusRun[] }).runs[0] ?? null;
}

/** The tool's text: the asked run, or the newest Stage runs, and the next call. */
export function formatStageStatus(value: unknown, args: { deployRunId?: string }): string {
  const runs = (value as { runs: StageStatusRun[] }).runs;
  if (args.deployRunId) {
    const run = runs[0];
    if (!run) {
      return `No Stage build run ${args.deployRunId}: either the Stage is still merging the chats' changes (call get_stage_status with this deployRunId once more in a minute), or the id is not a Stage build. If it still does not exist then, the Stage stopped before its build: call stage_changes again.`;
    }
    return [
      `Stage build run ${run.runId} (${run.targetName}): ${describeStageRun(run)}.`,
      stageNextStep(run),
    ].join("\n");
  }
  if (runs.length === 0) return "No Stage has run on this site yet.";
  const lines = runs.map(
    (r) => `- run ${r.runId} (${r.targetName}, started ${r.startedAt}): ${describeStageRun(r)}`,
  );
  const newest = runs[0] as StageStatusRun;
  return ["Stage runs, newest first:", ...lines, "", `Newest: ${stageNextStep(newest)}`].join("\n");
}

export const getStageStatusTool = makeReadTool<z.infer<typeof input>>({
  name: "get_stage_status",
  description:
    "Where Stage builds stand: phase, pages built, run time, estimated time left (with its basis) and a failed run's reason + step. No args = newest Stage runs.\n" +
    "USE FOR: a Stage that outlasted `stage_changes`' wait; the operator asks how far staging is or why a Stage failed. DO NOT USE FOR quality scores/findings -> `get_quality_audit`.\n" +
    "CORE RULES: call again only after the estimated time has passed, never in a loop. Never re-run `stage_changes` for a queued/running Stage. Succeeded -> `get_quality_audit` with that `deployRunId`.",
  opName: "deploy.stage_status",
  input,
  format: formatStageStatus,
});
