// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — the plugin-data tick: the ONE entry point that brings stale
 * plugin bakes into the live HTML.
 *
 * {@link runPluginDataBuildIfDue} reads the visitor hints that arrived
 * since the last tick (plugin-data/visitor-hints.ts), then runs at most one
 * `deploy.build_plugin_data`, which batches every pending mark into one
 * build (plugin-data/build.ts). The op itself makes the tick safe to call
 * from every admin instance and as often as one likes: a try-lock lets one
 * build run at a time, and `minIntervalSeconds` skips a tick that comes too
 * soon after the previous one (any instance's).
 *
 * Until the scheduler tick of epic #1140 exists, the admin drives it from
 * `bootstrapMaintenanceWorkers()` every {@link PLUGIN_DATA_TICK_MS} —
 * #1140's 5-minute default cadence. Moving it is one line there: the
 * scheduler calls `runPluginDataBuildIfDue` per tick instead. Nothing calls
 * it per request.
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

/** The tick cadence until #1140's scheduler drives it (its 5-minute default). */
export const PLUGIN_DATA_TICK_MS = 5 * 60 * 1000;

/** First tick soon after start: a scale-to-zero admin may not live five minutes. */
const FIRST_TICK_MS = 60_000;

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
 * is pending and the previous tick is at least `minIntervalSeconds` ago.
 *
 * @param opts.minIntervalSeconds - default: a little under the tick, so
 *   one instance's tick is never skipped for its own previous one.
 * @throws when the build op fails (its message names the cause); a
 *   blocked build is an outcome, not a throw.
 */
export async function runPluginDataBuildIfDue(deps: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly minIntervalSeconds?: number;
  readonly repoRoot?: string;
}): Promise<PluginDataTickResult> {
  const hints = await ingestVisitorHints(deps.adapter, deps.registry);
  const r = await execute(deps.registry, deps.adapter, SYSTEM_CTX, "deploy.build_plugin_data", {
    minIntervalSeconds: deps.minIntervalSeconds ?? Math.floor((PLUGIN_DATA_TICK_MS * 0.8) / 1000),
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

async function tickOnce(deps: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}): Promise<void> {
  try {
    const r = await runPluginDataBuildIfDue(deps);
    if (r.outcome === "blocked") console.warn(`[plugin-data] not built: ${r.message}`);
  } catch (e) {
    // Loud, and retried on the next tick; the items stay visible through
    // the delta feed meanwhile.
    console.error("[plugin-data] tick failed", e);
  }
}

/**
 * Start the interim tick loop. Returns a stop handle (tests; the admin
 * process runs it for its lifetime).
 */
export function startPluginDataBuildWorker(opts: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly intervalMs?: number;
  readonly firstTickMs?: number;
}): { stop(): void } {
  const first = setTimeout(() => {
    void tickOnce(opts);
  }, opts.firstTickMs ?? FIRST_TICK_MS);
  const handle = setInterval(() => {
    void tickOnce(opts);
  }, opts.intervalMs ?? PLUGIN_DATA_TICK_MS);
  return {
    stop(): void {
      clearTimeout(first);
      clearInterval(handle);
    },
  };
}
