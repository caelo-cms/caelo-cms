// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — the plugin-data tick: the ONE entry point that brings stale
 * plugin bakes into the live HTML.
 *
 * {@link runPluginDataBuildIfDue} reads the visitor hints that arrived
 * since the last run (plugin-data/visitor-hints.ts), then runs at most one
 * `deploy.build_plugin_data`, which batches every pending mark into one
 * build (plugin-data/build.ts). The op itself makes the call safe from every
 * admin instance and as often as one likes: a try-lock lets one build run at
 * a time, and `minIntervalSeconds` skips a call that comes too soon after
 * the previous one (any instance's).
 *
 * The scheduler tick (#1140, scheduler/core-tasks.ts) calls it every five
 * minutes; nothing calls it per request.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import { SYSTEM_ACTOR_ID } from "../audit.js";
import type { PluginDataBuildOutcome } from "./build.js";
import { ingestVisitorHints } from "./visitor-hints.js";

const SYSTEM_CTX = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system" as const,
  requestId: "plugin-data-tick",
};

/** What one tick did. */
export interface PluginDataTickResult {
  /** Pages the visitor hints of this tick marked stale. */
  readonly hintedPages: number;
  readonly outcome: PluginDataBuildOutcome;
  readonly runIds: readonly string[];
  readonly message: string | null;
}

/**
 * Run one plugin-data tick: ingest visitor hints, then build if anything
 * is pending and the previous build is at least `minIntervalSeconds` ago.
 *
 * @param deps.minIntervalSeconds - the op's own spacing between builds
 *   (its default when omitted); the scheduler task passes 0, because the
 *   due-table already spaces its runs.
 * @throws when the build op fails (its message names the cause); a
 *   blocked build is an outcome, not a throw.
 */
export async function runPluginDataBuildIfDue(deps: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly minIntervalSeconds?: number;
  readonly maxMarks?: number;
  readonly repoRoot?: string;
}): Promise<PluginDataTickResult> {
  const hints = await ingestVisitorHints(deps.adapter, deps.registry);
  const r = await execute(deps.registry, deps.adapter, SYSTEM_CTX, "deploy.build_plugin_data", {
    ...(deps.minIntervalSeconds !== undefined
      ? { minIntervalSeconds: deps.minIntervalSeconds }
      : {}),
    ...(deps.maxMarks ? { maxMarks: deps.maxMarks } : {}),
    ...(deps.repoRoot ? { repoRoot: deps.repoRoot } : {}),
  });
  if (!r.ok) {
    throw new Error(`deploy.build_plugin_data failed: ${JSON.stringify(r.error)}`);
  }
  const v = r.value as {
    outcome: PluginDataBuildOutcome;
    runIds: string[];
    message: string | null;
  };
  return { hintedPages: hints.marked, outcome: v.outcome, runIds: v.runIds, message: v.message };
}
