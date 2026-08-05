// SPDX-License-Identifier: MPL-2.0

/**
 * e2e-livedit token & cache metrics — pure core (issue #432).
 *
 * Parses the admin server's per-loop `[chat-runner] loop`, per-tool
 * `[chat-runner] tool-tokens` and per-turn `[chat-runner] context-split`
 * traces out of admin.log text, aggregates them per chat session /
 * operator turn, and derives an INPUT ATTRIBUTION per scenario: how much
 * of the total input rode as per-call static context (system prompt /
 * tool catalogue / context blocks / engaged-skill bodies) versus growing
 * message history — plus per-loop history growth. That split is what
 * makes an input-token regression attributable instead of a mystery
 * number (issue #432's first acceptance criterion).
 *
 * Pure by design: no filesystem, no Playwright imports — `build-stats.ts`
 * (a standalone CI post-process) and `livedit-metrics.ts` (the
 * scenario-facing harness surface, which owns paths + thresholds-gating)
 * both consume this module. The previous split, where build-stats kept
 * its own regex over the loop lines, drifted the moment the log format
 * gained a `tokensCached` field and silently reported 0 loops — one
 * parser, imported twice, cannot drift.
 */

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
  /** chars/4 estimate of the message history sent THIS call (`sentPrefixEstimate`). */
  prefixEst: number;
}

/** One tool result appended this loop (`[chat-runner] tool-tokens`). */
export interface ToolResult {
  name: string;
  ok: boolean;
  tokens: number;
}
export interface ToolRow {
  session: string;
  loop: number;
  results: ToolResult[];
}

/**
 * One per-turn `[chat-runner] context-split` record (issue #300 part A):
 * the chars/4 estimate of where the turn's loop-0 input goes. The static
 * components (system prompt, tool catalogue, context blocks, engaged-skill
 * bodies) ride EVERY loop of the turn unchanged — the system prompt is
 * static per CLAUDE.md §11 — so per-call static cost × loop count is the
 * turn's static input bill, and history is the rest.
 */
export interface ContextSplitRow {
  session: string;
  totalTokens: number;
  systemPromptTokens: number;
  toolCatalogueTokens: number;
  contextBlockTokens: Record<string, number>;
  skillTokens: Record<string, number>;
  historyTokens: number;
  historyMessages: number;
}

function num(block: string, key: string): number {
  const m = new RegExp(`\\b${key}:\\s*(-?\\d+)`).exec(block);
  return m ? Number(m[1]) : Number.NaN;
}
function str(block: string, key: string): string {
  const m = new RegExp(`${key}:\\s*"([^"]*)"`).exec(block);
  return m ? (m[1] ?? "") : "";
}

/**
 * Extract a `key: { "a": 1, b: 2 }` nested numeric map from an inspect
 * block. Handles both quoted and bare keys and the multi-line layout the
 * console inspector emits for larger objects.
 */
function nestedNums(block: string, key: string): Record<string, number> {
  const start = new RegExp(`\\b${key}:\\s*\\{`).exec(block);
  const out: Record<string, number> = {};
  if (!start) return out;
  const from = start.index + start[0].length;
  const end = block.indexOf("}", from);
  if (end === -1) return out;
  const body = block.slice(from, end);
  const re = /"?([\w./-]+)"?:\s*(-?\d+)/g;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    out[m[1] ?? ""] = Number(m[2]);
  }
  return out;
}

/** Grab each `marker … {` block up to its closing `}` line (console.error object dumps). */
function blocksFor(lines: string[], marker: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || !line.includes(marker)) continue;
    const buf = [line];
    for (let j = i + 1; j < lines.length && j < i + 60; j++) {
      const l = lines[j];
      if (l === undefined) break;
      buf.push(l);
      if (l.trimEnd() === "}") break;
    }
    out.push(buf.join("\n"));
  }
  return out;
}

/** Parse the loop + tool-token + context-split traces out of a chunk of admin.log text. */
export function parseChatLog(text: string): {
  loops: LoopRow[];
  tools: ToolRow[];
  splits: ContextSplitRow[];
} {
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
    for (let m = re.exec(b); m !== null; m = re.exec(b)) {
      results.push({ name: m[1] ?? "", ok: m[2] === "true", tokens: Number(m[3]) });
    }
    return { session, loop, results };
  });
  const splits = blocksFor(lines, "[chat-runner] context-split {").map((b) => ({
    session: str(b, "chatSessionId"),
    totalTokens: num(b, "totalTokens"),
    systemPromptTokens: num(b, "systemPromptTokens"),
    toolCatalogueTokens: num(b, "toolCatalogueTokens"),
    contextBlockTokens: nestedNums(b, "contextBlockTokens"),
    skillTokens: nestedNums(b, "skillTokens"),
    historyTokens: num(b, "historyTokens"),
    historyMessages: num(b, "historyMessages"),
  }));
  return { loops, tools, splits };
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
  /** This turn's context-split record, when the log carried one. */
  split?: ContextSplitRow;
}
export interface ToolUsage {
  name: string;
  calls: number;
  tokens: number;
}

/**
 * Where the scenario's total input went — the issue #432 breakdown. All
 * figures are chars/4 estimates EXCEPT the actual comparison base
 * (`Totals.inCall`, real provider tokens); `estCoveragePct` says how much
 * of the actual input the estimate explains (images + provider framing +
 * estimator error make up the rest).
 */
export interface InputAttribution {
  /** Static context re-sent with every call: system + tools + blocks + skills (per-call est). */
  staticPerCallTokens: number;
  systemPromptTokens: number;
  toolCatalogueTokens: number;
  contextBlockTokens: number;
  /** Per-slug engaged-skill body estimate (per-call; merged across turns). */
  skillTokens: Record<string, number>;
  /** Σ per turn: staticPerCall × loops — the static share of the scenario's input. */
  staticTotalTokens: number;
  /** Σ of each loop's history estimate — the history/tool-result share. */
  historyTotalTokens: number;
  /** History estimate at the scenario's last loop (context size at the end). */
  historyEndTokens: number;
  /** Largest per-loop history estimate — the meaningful "how big did the context get" figure when a later turn restarts small. */
  historyPeakTokens: number;
  /** (static + history est) / actual input, in percent. */
  estCoveragePct: number;
}

export interface ScenarioMetrics {
  turns: TurnMetrics[];
  totals: Totals;
  cacheHitPct: number;
  freshPct: number;
  /** Per-tool result-token consumption, biggest first. */
  perTool: ToolUsage[];
  /** Input breakdown; undefined when the log carried no context-split lines. */
  attribution?: InputAttribution;
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
const sumValues = (m: Record<string, number>): number =>
  Object.values(m).reduce((a, b) => a + b, 0);

/** Static per-call estimate of one split: everything except history. */
function staticPerCall(s: ContextSplitRow): number {
  return (
    s.systemPromptTokens +
    s.toolCatalogueTokens +
    sumValues(s.contextBlockTokens) +
    sumValues(s.skillTokens)
  );
}

function buildAttribution(turns: TurnMetrics[], totals: Totals): InputAttribution | undefined {
  const withSplit = turns.filter((t) => t.split !== undefined);
  if (withSplit.length === 0) return undefined;

  let staticTotal = 0;
  const skillTokens: Record<string, number> = {};
  for (const t of withSplit) {
    const s = t.split;
    if (!s) continue;
    staticTotal += staticPerCall(s) * t.totals.loops;
    // Per-call skill estimate: keep the largest observed per slug (turns
    // engage skills independently; max is the honest "rides a call" figure).
    for (const [slug, tok] of Object.entries(s.skillTokens)) {
      skillTokens[slug] = Math.max(skillTokens[slug] ?? 0, tok);
    }
  }
  // History: every loop's sent-prefix estimate, across ALL turns (loops
  // without a split still sent history; prefixEst is per-loop data).
  let historyTotal = 0;
  let historyEnd = 0;
  let historyPeak = 0;
  for (const t of turns) {
    for (const r of t.rows) {
      if (Number.isFinite(r.prefixEst)) {
        historyTotal += r.prefixEst;
        historyEnd = r.prefixEst;
        if (r.prefixEst > historyPeak) historyPeak = r.prefixEst;
      }
    }
  }

  const first = withSplit[0]?.split;
  return {
    staticPerCallTokens: first ? staticPerCall(first) : 0,
    systemPromptTokens: first?.systemPromptTokens ?? 0,
    toolCatalogueTokens: first?.toolCatalogueTokens ?? 0,
    contextBlockTokens: first ? sumValues(first.contextBlockTokens) : 0,
    skillTokens,
    staticTotalTokens: staticTotal,
    historyTotalTokens: historyTotal,
    historyEndTokens: historyEnd,
    historyPeakTokens: historyPeak,
    estCoveragePct: pct(staticTotal + historyTotal, totals.inCall),
  };
}

/**
 * Aggregate parsed rows into per-turn metrics. Turns split on a loop-counter
 * reset (each `runToolLoop` invocation restarts at 0), preserving chronological
 * order. All rows passed in are treated as ONE scenario (callers scope by
 * log window or session before calling). Context-split records attach to
 * turns in order per session — the runner emits exactly one before each
 * turn's loop 0, and the suite runs scenarios sequentially (workers: 1).
 */
export function aggregate(
  loops: LoopRow[],
  tools: ToolRow[],
  splits: ContextSplitRow[] = [],
): ScenarioMetrics {
  const splitQueues = new Map<string, ContextSplitRow[]>();
  for (const s of splits) {
    const q = splitQueues.get(s.session) ?? [];
    q.push(s);
    splitQueues.set(s.session, q);
  }

  const turns: TurnMetrics[] = [];
  let prevLoop = Number.POSITIVE_INFINITY;
  for (const r of loops) {
    if (r.loop <= prevLoop) {
      turns.push({
        turnNo: turns.length + 1,
        session: r.session,
        rows: [],
        totals: zero(),
        split: splitQueues.get(r.session)?.shift(),
      });
    }
    prevLoop = r.loop;
    const cur = turns[turns.length - 1];
    if (!cur) continue;
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
    attribution: buildAttribution(turns, totals),
  };
}

/**
 * Group a WHOLE log's text into per-chat-session metrics — the complete
 * breakdown global-teardown emits so every session (even scenarios that
 * don't wire `recordScenarioMetrics`) appears in the PR artifact.
 * Sessions are returned in first-seen order.
 */
export function metricsBySessionText(
  logText: string,
): { session: string; metrics: ScenarioMetrics }[] {
  const { loops, tools, splits } = parseChatLog(logText);
  const order: string[] = [];
  const grouped = new Map<
    string,
    { loops: LoopRow[]; tools: ToolRow[]; splits: ContextSplitRow[] }
  >();
  const bucket = (s: string) => {
    let g = grouped.get(s);
    if (!g) {
      g = { loops: [], tools: [], splits: [] };
      grouped.set(s, g);
      order.push(s);
    }
    return g;
  };
  for (const r of loops) bucket(r.session).loops.push(r);
  for (const t of tools) bucket(t.session).tools.push(t);
  for (const s of splits) bucket(s.session).splits.push(s);
  return order.map((session) => {
    const g = grouped.get(session) ?? { loops: [], tools: [], splits: [] };
    return { session, metrics: aggregate(g.loops, g.tools, g.splits) };
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export const k = (n: number): string => (Number.isFinite(n) ? `${(n / 1000).toFixed(1)}k` : "?");
const usd = (n: number): string => `$${n.toFixed(3)}`;

/**
 * Rough $ rates for a per-scenario cost ESTIMATE. The authoritative total
 * is the `ai_calls` aggregation the CI already emits (`e2e-livedit-cost`);
 * this is a readable per-scenario breakdown alongside the tokens.
 * Token rates: Claude Sonnet-5 intro ($/1M). Image: Nano Banana
 * (gemini-2.5-flash-image) $/image. Update if the livedit model changes.
 */
export const RATES = {
  freshInPerM: 2,
  cacheReadPerM: 0.2,
  cacheWritePerM: 2.5,
  outPerM: 10,
  imagePerCall: 0.039,
};

export interface CostBreakdown {
  chat: number;
  image: number;
  total: number;
  imageCalls: number;
}

/** Estimated USD cost for a scenario: chat tokens + image-generation calls. */
export function estimateCostUsd(m: ScenarioMetrics): CostBreakdown {
  const T = m.totals;
  const chat =
    (T.freshIn * RATES.freshInPerM +
      T.cacheRead * RATES.cacheReadPerM +
      T.cacheWrite * RATES.cacheWritePerM +
      T.out * RATES.outPerM) /
    1e6;
  const imageCalls = m.perTool.find((u) => u.name === "generate_image")?.calls ?? 0;
  const image = imageCalls * RATES.imagePerCall;
  return { chat, image, total: chat + image, imageCalls };
}

/** The attribution lines of the report — also spliced into the PR comment by build-stats. */
export function formatAttribution(m: ScenarioMetrics): string[] {
  const a = m.attribution;
  if (!a) return ["INPUT ATTRIBUTION: n/a (no [chat-runner] context-split lines in this window)"];
  const skills = Object.entries(a.skillTokens)
    .sort((x, y) => y[1] - x[1])
    .map(([slug, tok]) => `${slug} ${k(tok)}`)
    .join(", ");
  const histStart = m.turns[0]?.rows[0]?.prefixEst ?? Number.NaN;
  const loops = m.totals.loops;
  const growth = a.historyEndTokens - (Number.isFinite(histStart) ? histStart : 0);
  return [
    `INPUT ATTRIBUTION (est chars/4 vs ${k(m.totals.inCall)} actual input):`,
    `  static/call = ${k(a.staticPerCallTokens)} (system ${k(a.systemPromptTokens)}, ` +
      `tool-catalogue ${k(a.toolCatalogueTokens)}, context-blocks ${k(a.contextBlockTokens)}, ` +
      `skills ${k(sumValues(a.skillTokens))}${skills ? ` [${skills}]` : ""})`,
    `  static x ${loops} loops = ${k(a.staticTotalTokens)} | history sum = ${k(a.historyTotalTokens)} ` +
      `| est covers ${a.estCoveragePct}% of actual`,
    `  history growth: ${k(histStart)} -> ${k(a.historyEndTokens)} (peak ${k(a.historyPeakTokens)}) over ${loops} loops` +
      (loops > 1 ? ` (avg ${k(growth / Math.max(1, loops - 1))}/loop)` : ""),
  ];
}

/** Human-readable per-turn/loop table + attribution + per-tool breakdown for one scenario. */
export function formatReport(title: string, m: ScenarioMetrics): string {
  const out: string[] = [`### ${title}`];
  for (const t of m.turns) {
    out.push(
      `\n-- turn ${t.turnNo} (${t.session.slice(0, 8)}) --`,
      "loop | stop        | srv | in     | read   | write  | fresh  | hit% | out    | hist   | tools",
    );
    for (const r of t.rows) {
      out.push(
        `${String(r.loop).padStart(4)} | ${r.stop.padEnd(11)} | ${String(r.serverToolCalls).padStart(3)} | ` +
          `${k(r.inCall).padStart(6)} | ${k(r.cacheRead).padStart(6)} | ${k(r.cacheWrite).padStart(6)} | ` +
          `${k(r.freshIn).padStart(6)} | ${String(r.hitPct).padStart(4)} | ${k(r.out).padStart(6)} | ` +
          `${k(r.prefixEst).padStart(6)} | ${r.toolNames.join(", ")}`,
      );
    }
    const tt = t.totals;
    out.push(
      `  turn ${t.turnNo}: in=${k(tt.inCall)} read=${k(tt.cacheRead)} write=${k(tt.cacheWrite)} ` +
        `fresh=${k(tt.freshIn)} out=${k(tt.out)} hit=${pct(tt.cacheRead, tt.inCall)}%`,
    );
    if (t.split) {
      out.push(
        `  context/call (est): system ${k(t.split.systemPromptTokens)} + ` +
          `tools ${k(t.split.toolCatalogueTokens)} + blocks ${k(sumValues(t.split.contextBlockTokens))} + ` +
          `skills ${k(sumValues(t.split.skillTokens))} | history@start ${k(t.split.historyTokens)}`,
      );
    }
  }
  const T = m.totals;
  const c = estimateCostUsd(m);
  out.push(
    `\nTOTALS: turns=${m.turns.length} loops=${T.loops} in=${k(T.inCall)} ` +
      `read=${k(T.cacheRead)} (${m.cacheHitPct}%) write=${k(T.cacheWrite)} ` +
      `fresh=${k(T.freshIn)} (${m.freshPct}%) out=${k(T.out)}`,
    ...formatAttribution(m),
    `COST (est): chat=${usd(c.chat)} + image=${usd(c.image)} (${c.imageCalls} img) = ${usd(c.total)}` +
      `  [authoritative total: CI ai_calls aggregation]`,
  );
  if (m.perTool.length > 0) {
    out.push("\ntokens per tool (result bodies added to context):");
    out.push("  tool                              | calls | tokens");
    for (const u of m.perTool) {
      out.push(
        `  ${u.name.padEnd(33)} | ${String(u.calls).padStart(5)} | ${k(u.tokens).padStart(7)}`,
      );
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
export function checkThresholds(m: ScenarioMetrics, th: ScenarioThresholds): ThresholdViolation[] {
  const v: ThresholdViolation[] = [];
  const buildTurn = m.turns[0];
  if (th.minBuildTurnCacheHitPct !== undefined && buildTurn) {
    const t0 = buildTurn.totals;
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
  // Homepage build+edit. Ceilings re-derived 2026-08-05 (issue #432) from
  // measured first attempts:
  //   healthy era (post design-quality self-review + tool-search + skill
  //   routing, runs of 2026-08-04/05): input ~1.0–1.65M, loops 16–21
  //   (e.g. 1342.5k/19 and 1467.1k/21 on run 30891873119; 1646.5k on main
  //   run 30897363718). The pre-#348 baseline this file used to cite
  //   (625–760k, 11–12 loops) predates those features — the old 1200k
  //   ceiling sat mid-distribution and failed healthy attempts.
  //   degraded era (stored-corruption repair spirals, runs 31000584991 /
  //   31000699422): input 2176.9k/27, 2505.6k/31, 2660.4k/33 — the model
  //   burning ~15–20 loops visually repairing module bodies our write path
  //   should have rejected (CDATA guard in packages/shared content.ts).
  // maxInputTokens = 2.0M ≈ 1.2× the worst measured healthy attempt and
  // BELOW the observed spiral floor (2.18M); maxLoops = 26 ≈ 1.25× the
  // worst healthy loop count and below the observed spiral counts (27+).
  // Both therefore still catch every observed degraded run while no longer
  // failing on healthy variance.
  homepage: {
    minBuildTurnCacheHitPct: 75,
    minCacheHitPct: 60,
    maxFreshPct: 10,
    maxInputTokens: 2_000_000,
    maxLoops: 26,
  },
};

// ---------------------------------------------------------------------------
// Scenario summaries (jsonl rows) + attempt-1 breach warnings
// ---------------------------------------------------------------------------

/** One scenario-attempt summary row (a `scenario-metrics.jsonl` line). */
export interface ScenarioSummary {
  scenario: string;
  loops: number;
  turns: number;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  freshIn: number;
  output: number;
  cacheHitPct: number;
  freshPct: number;
  imageCalls: number;
  costChatUsd: number;
  costImageUsd: number;
  costTotalUsd: number;
  perTool: ToolUsage[];
  /** issue #432 — input breakdown for the run report; absent on older logs. */
  attribution?: InputAttribution;
  /**
   * Threshold breaches of THIS attempt. Persisted so a breach stays visible
   * (as a `::warning` annotation) even when a Playwright retry later passes
   * — silent pass-on-retry is how #432 went unnoticed across three PRs.
   */
  violations: ThresholdViolation[];
}

/** Build the jsonl summary row for one scenario attempt. */
export function summarizeScenario(
  scenarioKey: string,
  m: ScenarioMetrics,
  violations: ThresholdViolation[],
): ScenarioSummary {
  const cost = estimateCostUsd(m);
  return {
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
    imageCalls: cost.imageCalls,
    costChatUsd: Number(cost.chat.toFixed(4)),
    costImageUsd: Number(cost.image.toFixed(4)),
    costTotalUsd: Number(cost.total.toFixed(4)),
    perTool: m.perTool,
    attribution: m.attribution,
    violations,
  };
}

/**
 * GitHub `::warning` workflow-command lines for every recorded attempt that
 * breached its thresholds — emitted by global-teardown so a breach annotates
 * the run EVEN WHEN a retry passed and the check went green (issue #432's
 * "attempt-1 breaches must be loud" acceptance criterion). Rows are jsonl
 * summaries in append order; the Nth row of a scenario is its Nth attempt.
 */
export function buildThresholdWarnings(rows: ScenarioSummary[]): string[] {
  const attemptNo = new Map<string, number>();
  const out: string[] = [];
  for (const row of rows) {
    const n = (attemptNo.get(row.scenario) ?? 0) + 1;
    attemptNo.set(row.scenario, n);
    if (!Array.isArray(row.violations) || row.violations.length === 0) continue;
    const details = row.violations.map((v) => v.message).join("; ");
    out.push(
      `::warning title=e2e-livedit thresholds (issue #432)::scenario '${row.scenario}' attempt ${n} breached: ` +
        `${details} — a later retry may have turned the check green; see the metrics-report.txt artifact.`,
    );
  }
  return out;
}
