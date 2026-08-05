// SPDX-License-Identifier: MPL-2.0

/**
 * e2e-livedit token & cache metrics — scenario-facing surface.
 *
 * The pure parsing/aggregation/report core lives in `lib/metrics-core.ts`
 * (shared with the standalone `lib/build-stats.ts` CI post-process; see the
 * drift note there). This module owns everything filesystem-bound: the
 * admin.log window capture, the per-scenario jsonl artifact, and the
 * thresholds gate scenarios assert on ({@link recordScenarioMetrics}).
 */

import { appendFileSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { ADMIN_LOG_DIR } from "./global-setup.js";
import type { ScenarioMetrics, ScenarioSummary, ThresholdViolation } from "./lib/metrics-core.js";
import {
  aggregate,
  buildThresholdWarnings,
  checkThresholds,
  formatReport,
  metricsBySessionText,
  parseChatLog,
  summarizeScenario,
  THRESHOLDS,
} from "./lib/metrics-core.js";

// Re-export the core surface so scenarios and global-teardown keep a single
// import site; the split into lib/ is an implementation detail to them.
export * from "./lib/metrics-core.js";

// ---------------------------------------------------------------------------
// Log-window capture (per-scenario attribution; workers:1 ⇒ sequential)
// ---------------------------------------------------------------------------

/** Byte offset of admin.log right now — call at a scenario's start. */
export function logOffset(adminLogPath: string): number {
  try {
    return statSync(adminLogPath).size;
  } catch {
    return 0;
  }
}

/**
 * Group the WHOLE log into per-chat-session metrics — the complete
 * breakdown global-teardown emits so every session (even scenarios that
 * don't wire {@link recordScenarioMetrics}) appears in the PR artifact.
 */
export function metricsBySession(logText: string): { session: string; metrics: ScenarioMetrics }[] {
  return metricsBySessionText(logText);
}

/** Aggregate metrics for the admin.log written since {@link logOffset}. */
export function metricsSince(adminLogPath: string, offset: number): ScenarioMetrics {
  const full = readFileSync(adminLogPath, "utf8");
  const tail = full.slice(offset);
  const { loops, tools, splits } = parseChatLog(tail);
  return aggregate(loops, tools, splits);
}

/** One JSON line per scenario attempt; global-teardown aggregates it into the PR artifact. */
export const SCENARIO_METRICS_JSONL = resolve(ADMIN_LOG_DIR, "scenario-metrics.jsonl");

/**
 * Scenario-facing entry point: print the per-turn/loop + attribution +
 * per-tool report, append the summary (INCLUDING any threshold violations,
 * so a breach on a retried attempt stays visible to
 * {@link buildThresholdWarnings}) to {@link SCENARIO_METRICS_JSONL}, and
 * return the violations. The scenario asserts the returned array is empty,
 * so a caching/token regression fails that scenario's e2e.
 */
export function recordScenarioMetrics(
  scenarioKey: string,
  m: ScenarioMetrics,
): ThresholdViolation[] {
  // eslint-disable-next-line no-console -- surfaced in the e2e/admin log on purpose.
  console.log(`\n[livedit-metrics]\n${formatReport(scenarioKey, m)}\n`);
  const violations = checkThresholds(m, THRESHOLDS[scenarioKey] ?? {});
  const summary: ScenarioSummary = summarizeScenario(scenarioKey, m, violations);
  try {
    appendFileSync(SCENARIO_METRICS_JSONL, `${JSON.stringify(summary)}\n`);
  } catch {
    // Non-fatal: the artifact is a convenience, thresholds still gate below.
  }
  return violations;
}
