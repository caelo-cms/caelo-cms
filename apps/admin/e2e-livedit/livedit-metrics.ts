// SPDX-License-Identifier: MPL-2.0

/**
 * e2e-livedit token & cache metrics.
 *
 * Parses the admin server's per-loop `[chat-runner] loop` and per-tool
 * `[chat-runner] tool-tokens` traces out of admin.log, aggregates them per
 * chat session / operator turn, and exposes:
 *   - a human-readable per-turn/loop report (also written as a PR artifact
 *     by global-teardown, so the numbers are on every CI run), and
 *   - {@link checkThresholds}, so a scenario can fail its e2e when caching
 *     or token behaviour regresses (e.g. homepage cache-hit drops < 65%).
 *
 * The parser is deliberately standalone (no admin-core import) so the e2e
 * harness stays decoupled from the code it measures.
 */

import { appendFileSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { ADMIN_LOG_DIR } from "./global-setup.js";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** One provider call (`[chat-runner] loop`). All token fields are real provider tokens. */
export interface LoopRow {
  session: string;
  loop: number;
  stop: string;
  toolNames: string[];
  serverToolCalls: number;
  inCall: number;
  cacheRead: number;
  cacheWrite: number;
  freshIn: number;
  out: number;
  hitPct: number;
  prefixEst: number;
}

/** One tool result appended this loop (`[chat-runner] tool-tokens`). */
export interface ToolResult {
  name: string;
  ok: boolean;
  tokens: number;
}
interface ToolRow {
  session: string;
  loop: number;
  results: ToolResult[];
}

function num(block: string, key: string): number {
  const m = new RegExp(`\\b${key}:\\s*(-?\\d+)`).exec(block);
  return m ? Number(m[1]) : Number.NaN;
}
function str(block: string, key: string): string {
  const m = new RegExp(`${key}:\\s*"([^"]*)"`).exec(block);
  return m ? (m[1] ?? "") : "";
}

/** Grab each `marker … {` block up to its closing `}` line (console.error object dumps). */
function blocksFor(lines: string[], marker: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes(marker)) continue;
    const buf = [lines[i]!];
    for (let j = i + 1; j < lines.length && j < i + 60; j++) {
      buf.push(lines[j]!);
      if (lines[j]!.trimEnd() === "}") break;
    }
    out.push(buf.join("\n"));
  }
  return out;
}

/** Parse the loop + tool-token traces out of a chunk of admin.log text. */
export function parseChatLog(text: string): { loops: LoopRow[]; tools: ToolRow[] } {
  const lines = text.split("\n");
  const loops = blocksFor(lines, "[chat-runner] loop {").map((b) => ({
    session: str(b, "chatSessionId"),
    loop: num(b, "loop"),
    stop: str(b, "loopStop"),
    toolNames: (/toolNames:\s*\[([^\]]*)\]/.exec(b)?.[1] ?? "")
      .split(",")
      .map((s) => s.replace(/["\s]/g, ""))
      .filter(Boolean),
    serverToolCalls: num(b, "serverToolCalls"),
    inCall: num(b, "inThisCall"),
    cacheRead: num(b, "cacheRead"),
    cacheWrite: num(b, "cacheWrite"),
    freshIn: num(b, "freshIn"),
    out: num(b, "outThisCall"),
    hitPct: num(b, "cacheHitPct"),
    prefixEst: num(b, "sentPrefixEstimate"),
  }));
  const tools = blocksFor(lines, "[chat-runner] tool-tokens {").map((b) => {
    const session = str(b, "chatSessionId");
    const loop = num(b, "loop");
    const results: ToolResult[] = [];
    // results: [ { name: "x", ok: true, tokens: N }, ... ]
    const re = /name:\s*"([^"]*)",\s*ok:\s*(true|false),\s*tokens:\s*(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b)) !== null) {
      results.push({ name: m[1]!, ok: m[2] === "true", tokens: Number(m[3]) });
    }
    return { session, loop, results };
  });
  return { loops, tools };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface Totals {
  inCall: number;
  cacheRead: number;
  cacheWrite: number;
  freshIn: number;
  out: number;
  loops: number;
}
export interface TurnMetrics {
  turnNo: number;
  session: string;
  rows: LoopRow[];
  totals: Totals;
}
export interface ToolUsage {
  name: string;
  calls: number;
  tokens: number;
}
export interface ScenarioMetrics {
  turns: TurnMetrics[];
  totals: Totals;
  cacheHitPct: number;
  freshPct: number;
  /** Per-tool result-token consumption, biggest first. */
  perTool: ToolUsage[];
}

const zero = (): Totals => ({
  inCall: 0,
  cacheRead: 0,
  cacheWrite: 0,
  freshIn: 0,
  out: 0,
  loops: 0,
});
function add(t: Totals, r: LoopRow): void {
  t.inCall += r.inCall;
  t.cacheRead += r.cacheRead;
  t.cacheWrite += r.cacheWrite;
  t.freshIn += r.freshIn;
  t.out += r.out;
  t.loops += 1;
}
function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * Aggregate parsed rows into per-turn metrics. Turns split on a loop-counter
 * reset (each `runToolLoop` invocation restarts at 0), preserving chronological
 * order. All rows passed in are treated as ONE scenario (callers scope by
 * log window or session before calling).
 */
export function aggregate(loops: LoopRow[], tools: ToolRow[]): ScenarioMetrics {
  const turns: TurnMetrics[] = [];
  let prevLoop = Number.POSITIVE_INFINITY;
  for (const r of loops) {
    if (r.loop <= prevLoop) {
      turns.push({ turnNo: turns.length + 1, session: r.session, rows: [], totals: zero() });
    }
    prevLoop = r.loop;
    const cur = turns[turns.length - 1]!;
    cur.rows.push(r);
    add(cur.totals, r);
  }
  const totals = zero();
  for (const r of loops) add(totals, r);

  const toolMap = new Map<string, ToolUsage>();
  for (const tr of tools) {
    for (const res of tr.results) {
      const u = toolMap.get(res.name) ?? { name: res.name, calls: 0, tokens: 0 };
      u.calls += 1;
      u.tokens += res.tokens;
      toolMap.set(res.name, u);
    }
  }
  const perTool = [...toolMap.values()].sort((a, b) => b.tokens - a.tokens);

  return {
    turns,
    totals,
    cacheHitPct: pct(totals.cacheRead, totals.inCall),
    freshPct: pct(totals.freshIn, totals.inCall),
    perTool,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const k = (n: number): string => (Number.isFinite(n) ? `${(n / 1000).toFixed(1)}k` : "?");

/** Human-readable per-turn/loop table + per-tool breakdown for one scenario. */
export function formatReport(title: string, m: ScenarioMetrics): string {
  const out: string[] = [`### ${title}`];
  for (const t of m.turns) {
    out.push(
      `\n-- turn ${t.turnNo} (${t.session.slice(0, 8)}) --`,
      "loop | stop        | srv | in     | read   | write  | fresh  | hit% | out    | tools",
    );
    for (const r of t.rows) {
      out.push(
        `${String(r.loop).padStart(4)} | ${r.stop.padEnd(11)} | ${String(r.serverToolCalls).padStart(3)} | ` +
          `${k(r.inCall).padStart(6)} | ${k(r.cacheRead).padStart(6)} | ${k(r.cacheWrite).padStart(6)} | ` +
          `${k(r.freshIn).padStart(6)} | ${String(r.hitPct).padStart(4)} | ${k(r.out).padStart(6)} | ${r.toolNames.join(", ")}`,
      );
    }
    const tt = t.totals;
    out.push(
      `  turn ${t.turnNo}: in=${k(tt.inCall)} read=${k(tt.cacheRead)} write=${k(tt.cacheWrite)} ` +
        `fresh=${k(tt.freshIn)} out=${k(tt.out)} hit=${pct(tt.cacheRead, tt.inCall)}%`,
    );
  }
  const T = m.totals;
  out.push(
    `\nTOTALS: turns=${m.turns.length} loops=${T.loops} in=${k(T.inCall)} ` +
      `read=${k(T.cacheRead)} (${m.cacheHitPct}%) write=${k(T.cacheWrite)} ` +
      `fresh=${k(T.freshIn)} (${m.freshPct}%) out=${k(T.out)}`,
  );
  if (m.perTool.length > 0) {
    out.push("\ntokens per tool (result bodies added to context):");
    out.push("  tool                              | calls | tokens");
    for (const u of m.perTool) {
      out.push(`  ${u.name.padEnd(33)} | ${String(u.calls).padStart(5)} | ${k(u.tokens).padStart(7)}`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Thresholds (PR test criteria)
// ---------------------------------------------------------------------------

export interface ScenarioThresholds {
  /** Floor for overall cache-hit % (cacheRead / total input). Catches gross cache breakage. */
  minCacheHitPct?: number;
  /**
   * Floor for the BUILD turn's cache-hit % (turn 1). This is "homepage
   * bauen" cache-hit — the meaningful signal, since the overall figure is
   * dragged down by cold follow-up edit turns (a fresh chat turn always
   * starts at 0% cache read). Build turns run 87–96%, so a 75% floor
   * catches regressions with comfortable margin.
   */
  minBuildTurnCacheHitPct?: number;
  /**
   * Ceiling for fresh % (freshIn / total input) — the ROBUST caching-regression
   * guard. Fresh = fully-uncached input billed at 1.0×; the message-breakpoint
   * bug drove it to ~26%. Far less noisy than cache-hit (no cold-start / cross-
   * run-warmth confound), so it is the primary guard.
   */
  maxFreshPct?: number;
  /** Ceiling for total input tokens across the scenario — context-bloat / no-compaction guard. */
  maxInputTokens?: number;
  /** Ceiling for total loops (all turns) — runaway-loop guard. */
  maxLoops?: number;
}

export interface ThresholdViolation {
  metric: string;
  actual: number;
  limit: number;
  message: string;
}

/** Check a scenario's metrics against its thresholds. Empty ⇒ all passed. */
export function checkThresholds(
  m: ScenarioMetrics,
  th: ScenarioThresholds,
): ThresholdViolation[] {
  const v: ThresholdViolation[] = [];
  if (th.minBuildTurnCacheHitPct !== undefined && m.turns.length > 0) {
    const t0 = m.turns[0]!.totals;
    const hit = t0.inCall > 0 ? Math.round((t0.cacheRead / t0.inCall) * 100) : 100;
    if (hit < th.minBuildTurnCacheHitPct) {
      v.push({
        metric: "buildTurnCacheHitPct",
        actual: hit,
        limit: th.minBuildTurnCacheHitPct,
        message: `build-turn cache-hit ${hit}% < floor ${th.minBuildTurnCacheHitPct}%`,
      });
    }
  }
  if (th.minCacheHitPct !== undefined && m.cacheHitPct < th.minCacheHitPct) {
    v.push({
      metric: "cacheHitPct",
      actual: m.cacheHitPct,
      limit: th.minCacheHitPct,
      message: `cache-hit ${m.cacheHitPct}% < floor ${th.minCacheHitPct}%`,
    });
  }
  if (th.maxFreshPct !== undefined && m.freshPct > th.maxFreshPct) {
    v.push({
      metric: "freshPct",
      actual: m.freshPct,
      limit: th.maxFreshPct,
      message: `uncached-fresh ${m.freshPct}% > ceiling ${th.maxFreshPct}% (caching regressed)`,
    });
  }
  if (th.maxInputTokens !== undefined && m.totals.inCall > th.maxInputTokens) {
    v.push({
      metric: "inputTokens",
      actual: m.totals.inCall,
      limit: th.maxInputTokens,
      message: `total input ${k(m.totals.inCall)} > ceiling ${k(th.maxInputTokens)}`,
    });
  }
  if (th.maxLoops !== undefined && m.totals.loops > th.maxLoops) {
    v.push({
      metric: "loops",
      actual: m.totals.loops,
      limit: th.maxLoops,
      message: `loops ${m.totals.loops} > ceiling ${th.maxLoops} (runaway)`,
    });
  }
  return v;
}

/**
 * Per-scenario thresholds. Tuned from observed baselines with margin — the
 * point is to catch REGRESSIONS (a caching bug, a compaction miss, a loop
 * explosion), not to pin exact numbers, since real-AI runs vary. Add a row
 * per scenario as baselines land; a missing row ⇒ report-only, no gating.
 */
export const THRESHOLDS: Record<string, ScenarioThresholds> = {
  // Homepage build+edit. Baselines across runs: build-turn cache-hit
  // 87–96%, overall 73–78% (cold edit turn drags it), fresh 0–2%, input
  // ~625–760k, loops 11–12. Floors/ceilings sit a comfortable margin away
  // so real-AI variance doesn't flake, but a caching/token regression does.
  homepage: {
    minBuildTurnCacheHitPct: 75,
    minCacheHitPct: 60,
    maxFreshPct: 10,
    maxInputTokens: 1_200_000,
    maxLoops: 30,
  },
};

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
 * Sessions are returned in first-seen order.
 */
export function metricsBySession(logText: string): { session: string; metrics: ScenarioMetrics }[] {
  const { loops, tools } = parseChatLog(logText);
  const order: string[] = [];
  const grouped = new Map<string, { loops: LoopRow[]; tools: ToolRow[] }>();
  const bucket = (s: string) => {
    let g = grouped.get(s);
    if (!g) {
      g = { loops: [], tools: [] };
      grouped.set(s, g);
      order.push(s);
    }
    return g;
  };
  for (const r of loops) bucket(r.session).loops.push(r);
  for (const t of tools) bucket(t.session).tools.push(t);
  return order.map((session) => {
    const g = grouped.get(session)!;
    return { session, metrics: aggregate(g.loops, g.tools) };
  });
}

/** Aggregate metrics for the admin.log written since {@link logOffset}. */
export function metricsSince(adminLogPath: string, offset: number): ScenarioMetrics {
  const full = readFileSync(adminLogPath, "utf8");
  const tail = full.slice(offset);
  const { loops, tools } = parseChatLog(tail);
  return aggregate(loops, tools);
}

/** One JSON line per scenario; global-teardown aggregates it into the PR artifact. */
export const SCENARIO_METRICS_JSONL = resolve(ADMIN_LOG_DIR, "scenario-metrics.jsonl");

/**
 * Scenario-facing entry point: print the per-turn/loop + per-tool report,
 * append the summary to {@link SCENARIO_METRICS_JSONL} for the PR artifact,
 * and return any threshold violations. The scenario asserts the returned
 * array is empty, so a caching/token regression fails that scenario's e2e.
 */
export function recordScenarioMetrics(scenarioKey: string, m: ScenarioMetrics): ThresholdViolation[] {
  // eslint-disable-next-line no-console -- surfaced in the e2e/admin log on purpose.
  console.log(`\n[livedit-metrics]\n${formatReport(scenarioKey, m)}\n`);
  const summary = {
    scenario: scenarioKey,
    loops: m.totals.loops,
    turns: m.turns.length,
    inputTokens: m.totals.inCall,
    cacheRead: m.totals.cacheRead,
    cacheWrite: m.totals.cacheWrite,
    freshIn: m.totals.freshIn,
    output: m.totals.out,
    cacheHitPct: m.cacheHitPct,
    freshPct: m.freshPct,
    perTool: m.perTool,
  };
  try {
    appendFileSync(SCENARIO_METRICS_JSONL, `${JSON.stringify(summary)}\n`);
  } catch {
    // Non-fatal: the artifact is a convenience, thresholds still gate below.
  }
  return checkThresholds(m, THRESHOLDS[scenarioKey] ?? {});
}
