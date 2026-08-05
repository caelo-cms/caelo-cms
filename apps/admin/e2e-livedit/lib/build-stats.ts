// SPDX-License-Identifier: MPL-2.0

/**
 * Emits a markdown stats summary for the e2e-livedit run. Reads
 *
 *   apps/admin/test-results/livedit/admin.log          (chat-runner stderr)
 *   apps/admin/test-results/livedit/playwright-report.json
 *   apps/admin/test-results/livedit/ai-cost.json        (real ai_calls totals)
 *   apps/admin/test-results/livedit/bug-reports.json    (ai_bug_reports rows)
 *
 * and writes a self-contained markdown block to stdout. The workflow
 * captures it and splices it into the sticky PR comment alongside the
 * screenshots + the per-test error blocks (PR #61).
 *
 * The ai-cost.json input carries the REAL per-run AI cost aggregated
 * from the `ai_calls` table (a `SET caelo.actor_kind='system'` psql
 * dump in the workflow). It is the authoritative source for tokens +
 * dollars — the loop-log token counts in admin.log are cumulative per
 * turn and would double-count if summed. When ai-cost.json is absent
 * (older runs, DB-only scenarios, a failed capture that fell back to
 * `{}`) the cost section is silently omitted.
 *
 * The bug-reports.json input carries every `ai_bug_reports` row filed
 * during the run — the model's own `bug_report` calls plus the
 * chat-runner's auto-capture of failed tool results and turn-fatal
 * provider errors. It is the signal the pass/fail verdict cannot
 * carry: a GREEN run whose bug count rose means the AI routed around a
 * defect rather than failing on it.
 *
 * NOT a Playwright reporter — those run in the test process and would
 * have to share state with the suite. This is a separate post-process
 * that's easier to evolve.
 */

import { existsSync, readFileSync } from "node:fs";

const ADMIN_LOG = "apps/admin/test-results/livedit/admin.log";
const REPORT_JSON = "apps/admin/test-results/livedit/playwright-report.json";
const AI_COST_JSON = "apps/admin/test-results/livedit/ai-cost.json";
const BUG_REPORTS_JSON = "apps/admin/test-results/livedit/bug-reports.json";

/** 1 USD = 1e8 microcents (cost_estimate_microcents is stored in microcents). */
const MICROCENTS_PER_USD = 100_000_000;

interface LoopRecord {
  chatSessionId: string;
  loopStop: string;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Parse the chat-runner's `[chat-runner] loop { ... }` blocks from the
 * admin stderr capture. The format is Node `util.inspect`, not JSON;
 * we scan with regex.
 *
 *   [chat-runner] loop {
 *     chatSessionId: "uuid",
 *     loop: 1,
 *     loopStop: "tool_use",
 *     toolCalls: 4,
 *     textChars: 131,
 *     thinkingBlocks: 0,
 *     tokensIn: 134803,
 *     tokensOut: 717,
 *   }
 */
function parseChatRunnerLoops(log: string): LoopRecord[] {
  const re =
    /\[chat-runner\] loop \{\s*chatSessionId:\s*"([^"]+)",[\s\S]*?loopStop:\s*"([^"]+)",[\s\S]*?toolCalls:\s*(\d+),[\s\S]*?tokensIn:\s*(\d+),\s*tokensOut:\s*(\d+),?\s*\}/g;
  const out: LoopRecord[] = [];
  let m: RegExpExecArray | null;
  m = re.exec(log);
  while (m !== null) {
    const [, chatSessionId, loopStop, toolCalls, tokensIn, tokensOut] = m;
    out.push({
      chatSessionId: chatSessionId ?? "",
      loopStop: loopStop ?? "",
      toolCalls: Number.parseInt(toolCalls ?? "0", 10),
      tokensIn: Number.parseInt(tokensIn ?? "0", 10),
      tokensOut: Number.parseInt(tokensOut ?? "0", 10),
    });
    m = re.exec(log);
  }
  return out;
}

/**
 * Count `[chat-runner] enter` lines as chat turns. The runner logs
 * `enter` at the top of each `runChatTurn` call; one per chat-send.
 */
function countEnters(log: string): number {
  return (log.match(/\[chat-runner\] enter \{/g) ?? []).length;
}

interface PWTestResult {
  title: string;
  ok: boolean;
  durationMs: number;
  status: string;
  retries: number;
}

/**
 * Walk Playwright's JSON report. The shape nests suites recursively;
 * each `spec.tests[]` carries the test outcome.
 */
function parsePlaywrightReport(json: string): {
  results: PWTestResult[];
  totalDurationMs: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { results: [], totalDurationMs: 0 };
  }
  const results: PWTestResult[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.specs)) {
      for (const s of o.specs) {
        const spec = s as { title: string; tests?: unknown[] };
        if (!Array.isArray(spec.tests)) continue;
        for (const t of spec.tests) {
          const test = t as {
            results?: { duration?: number; status?: string; retry?: number }[];
          };
          if (!Array.isArray(test.results) || test.results.length === 0) continue;
          // Last attempt is the authoritative outcome.
          const last = test.results.at(-1);
          const status = last?.status ?? "unknown";
          results.push({
            title: spec.title,
            ok: status === "passed",
            durationMs: last.duration ?? 0,
            status,
            retries: last.retry ?? 0,
          });
        }
      }
    }
    if (Array.isArray(o.suites)) {
      for (const child of o.suites) walk(child);
    }
  }
  walk(parsed);
  const totalDurationMs = (parsed as { stats?: { duration?: number } }).stats?.duration ?? 0;
  return { results, totalDurationMs };
}

/** Per-model cost breakdown row from the ai_calls aggregate. */
interface AiCostByModel {
  model: string | null;
  calls: number;
  microcents: number;
}

/**
 * Real AI cost aggregated from `ai_calls` for this run. Every column is
 * a SUM/COUNT over the fresh-per-job table, so it needs no date filter.
 * `unpricedCalls` counts rows with zero cost despite token work — the
 * #297 signature (a missing `ai_pricing` row zeroing the estimate).
 */
interface AiCost {
  totalMicrocents: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  unpricedCalls: number;
  byModel: AiCostByModel[];
}

function toNum(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse the `ai-cost.json` capture into an {@link AiCost}, or `null` when
 * the input carries no real data. Returns `null` for: an empty/whitespace
 * string (file missing), unparseable content, or the `{}` fallback the
 * workflow writes when the psql capture fails (it lacks the `calls` key).
 *
 * Defensive by construction: if a stray command tag leaks in front of the
 * JSON (e.g. a `SET`\n line from psql), we retry on the `{…}` substring
 * before giving up — so a formatting hiccup degrades to a parsed section,
 * not an omitted one.
 *
 * @param raw the file contents (pass "" when the file does not exist).
 */
export function parseAiCost(raw: string): AiCost | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let parsed: unknown = tryJson(trimmed);
  if (parsed === undefined) {
    // Salvage a JSON object embedded in noise (leading psql command tag).
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last > first) parsed = tryJson(trimmed.slice(first, last + 1));
  }
  if (!parsed || typeof parsed !== "object") return null;

  const o = parsed as Record<string, unknown>;
  // The `{}` capture-failure fallback has no `calls` key — treat as absent.
  if (!("calls" in o)) return null;

  const byModel: AiCostByModel[] = Array.isArray(o.byModel)
    ? o.byModel.map((r) => {
        const row = (r ?? {}) as Record<string, unknown>;
        return {
          model: typeof row.model === "string" ? row.model : null,
          calls: toNum(row.calls),
          microcents: toNum(row.microcents),
        };
      })
    : [];

  return {
    totalMicrocents: toNum(o.totalMicrocents),
    calls: toNum(o.calls),
    inputTokens: toNum(o.inputTokens),
    outputTokens: toNum(o.outputTokens),
    cachedTokens: toNum(o.cachedTokens),
    unpricedCalls: toNum(o.unpricedCalls),
    byModel,
  };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Format microcents as a USD string. Sub-cent amounts show four decimals
 * (a $0.0042 run is still a meaningful optimization signal); a dollar or
 * more rounds to cents.
 */
function fmtUsd(microcents: number): string {
  const usd = microcents / MICROCENTS_PER_USD;
  const decimals = usd !== 0 && usd < 0.01 ? 4 : 2;
  return `$${usd.toFixed(decimals)}`;
}

/**
 * Render the `### Real AI cost (this run)` markdown section. Returns an
 * empty array when `cost` is `null` so the caller can splice it in
 * unconditionally — no cost data ⇒ no section.
 */
export function formatCostSection(cost: AiCost | null): string[] {
  if (!cost) return [];
  const lines: string[] = [];
  lines.push("### Real AI cost (this run)");
  lines.push("");
  lines.push(
    `- **${fmtUsd(cost.totalMicrocents)}** total across **${cost.calls}** call${
      cost.calls === 1 ? "" : "s"
    } (from \`ai_calls\`)`,
  );
  lines.push(
    `- **${fmtTokens(cost.inputTokens)}** tokens in / **${fmtTokens(
      cost.outputTokens,
    )}** out / **${fmtTokens(cost.cachedTokens)}** cached`,
  );
  lines.push("");
  if (cost.byModel.length > 0) {
    lines.push("| Model | Calls | Cost |");
    lines.push("| --- | --- | --- |");
    for (const m of cost.byModel) {
      lines.push(`| \`${m.model ?? "(unknown)"}\` | ${m.calls} | ${fmtUsd(m.microcents)} |`);
    }
    lines.push("");
  }
  if (cost.unpricedCalls > 0) {
    lines.push(
      `**⚠️ ${cost.unpricedCalls} call(s) unpriced (missing \`ai_pricing\` row) — real cost is HIGHER than shown; add rates at \`/security/ai\`.**`,
    );
    lines.push("");
  }
  return lines;
}

/**
 * One `ai_bug_reports` row as captured by the workflow's psql dump.
 * Mirrors the table (migrations 0165 + 0177); `source` is `'ai'` when the
 * model filed it via the `bug_report` tool and `'auto'` when the chat-runner
 * captured it from a failed tool result or a turn-fatal provider error.
 */
interface BugReport {
  id: string;
  createdAt: string;
  chatSessionId: string | null;
  title: string;
  whatHappened: string;
  expected: string;
  suspectedTool: string | null;
  evidence: string | null;
  severity: string;
  blockedTask: boolean;
  status: string;
  source: string;
}

/** Rendered rows are capped so a pathological run can't blow GitHub's 65k comment limit. */
const BUG_TABLE_MAX_ROWS = 50;
/** Per-field cap inside the details block. The artifact carries the untruncated text. */
const BUG_DETAIL_MAX_CHARS = 600;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Parse the `bug-reports.json` capture into rows, or `null` when the input
 * carries no capture data at all.
 *
 * The null-vs-empty split is load-bearing and drives {@link formatBugSection}:
 * `null` (missing file, unparseable content, or the `{}` sentinel the workflow
 * writes when the psql capture fails) omits the section entirely, while `[]`
 * (a capture that ran and found nothing) renders the zero-state. Without the
 * distinction a clean run and a broken capture would look identical.
 *
 * Same defensive salvage as {@link parseAiCost}: if a stray psql command tag
 * leaks in front of the JSON we retry on the `[…]` substring.
 *
 * @param raw the file contents (pass "" when the file does not exist).
 */
export function parseBugReports(raw: string): BugReport[] | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let parsed: unknown = tryJson(trimmed);
  if (parsed === undefined) {
    const first = trimmed.indexOf("[");
    const last = trimmed.lastIndexOf("]");
    if (first !== -1 && last > first) parsed = tryJson(trimmed.slice(first, last + 1));
  }
  // The `{}` capture-failure sentinel parses fine but isn't an array — absent.
  if (!Array.isArray(parsed)) return null;

  return parsed.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    return {
      id: str(row.id),
      createdAt: str(row.createdAt),
      chatSessionId: strOrNull(row.chatSessionId),
      title: str(row.title),
      whatHappened: str(row.whatHappened),
      expected: str(row.expected),
      suspectedTool: strOrNull(row.suspectedTool),
      evidence: strOrNull(row.evidence),
      severity: str(row.severity),
      blockedTask: row.blockedTask === true,
      status: str(row.status),
      source: str(row.source),
    };
  });
}

/** Blocking first — the ordering a reader scanning the table wants. */
const SEVERITY_RANK: Record<string, number> = { blocking: 0, degraded: 1, cosmetic: 2 };

/** Cap length and flatten whitespace — for table cells and inline bullets, where a newline breaks markdown. */
function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Cap length but KEEP newlines — for text rendered inside a fenced block.
 * The provider-error digest is line-oriented (`#0 user`, `#1 assistant …`),
 * so flattening it would destroy the very structure that makes it readable.
 */
function truncateBlock(s: string, max: number): string {
  const trimmed = s.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Escape the pipes that would split a markdown table cell. Newlines are already flattened by {@link truncate}. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/**
 * Render the `### Detected bugs (N)` markdown section from the `ai_bug_reports`
 * rows filed during the run.
 *
 * Returns an empty array when `reports` is `null` (no capture data) so the
 * caller can splice unconditionally — matching {@link formatCostSection}. An
 * empty array of reports is NOT the same thing: it renders an explicit
 * zero-state, because "no bugs were filed" is the result we most want to see
 * stated out loud.
 *
 * Rows sort by severity, then source, then time, so `auto` and `ai` rows
 * cluster inside each severity band. Sorting lives here rather than in the
 * capture SQL so it is unit-testable.
 */
export function formatBugSection(reports: BugReport[] | null): string[] {
  if (!reports) return [];

  const lines: string[] = [];
  if (reports.length === 0) {
    lines.push("### Detected bugs (0)");
    lines.push("");
    lines.push("_None filed during this run._");
    lines.push("");
    return lines;
  }

  const sorted = [...reports].sort((a, b) => {
    const rank = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
    if (rank !== 0) return rank;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
  const shown = sorted.slice(0, BUG_TABLE_MAX_ROWS);
  const dropped = sorted.length - shown.length;

  lines.push(`### Detected bugs (${sorted.length})`);
  lines.push("");
  lines.push("| Sev | Source | Title | Tool | Blocked |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const b of shown) {
    // `suspected_tool` is freeform text up to 200 chars — the AI sometimes
    // names several tools at once — so cap it or it stretches the table.
    const tool = b.suspectedTool ? `\`${cell(truncate(b.suspectedTool, 40))}\`` : "—";
    lines.push(
      `| ${b.severity || "—"} | ${b.source || "—"} | ${cell(truncate(b.title, 80))} | ${tool} | ${
        b.blockedTask ? "yes" : "no"
      } |`,
    );
  }
  lines.push("");
  if (dropped > 0) {
    // Never truncate silently (CLAUDE.md) — say what was dropped and where it lives.
    lines.push(
      `_…${dropped} more not shown — see the \`e2e-livedit-bugs-<run_id>\` artifact for the full set._`,
    );
    lines.push("");
  }

  // A title alone isn't actionable and the full rows are artifact-only, so
  // carry the diagnosis inline — collapsed, to keep the comment scannable.
  lines.push("<details>");
  lines.push(`<summary>Bug details (${shown.length})</summary>`);
  lines.push("");
  for (const [i, b] of shown.entries()) {
    lines.push(`**${i + 1}. [${b.severity} · ${b.source}] ${truncate(b.title, 200)}**`);
    lines.push("");
    if (b.suspectedTool) lines.push(`- Suspected tool: \`${b.suspectedTool}\``);
    if (b.chatSessionId) lines.push(`- Chat session: \`${b.chatSessionId}\``);
    lines.push(`- What happened: ${truncate(b.whatHappened, BUG_DETAIL_MAX_CHARS)}`);
    lines.push(`- Expected: ${truncate(b.expected, BUG_DETAIL_MAX_CHARS)}`);
    if (b.evidence) {
      lines.push("- Evidence:");
      lines.push("");
      // Four backticks so evidence containing a ``` fence can't break out.
      lines.push("````");
      lines.push(truncateBlock(b.evidence, BUG_DETAIL_MAX_CHARS));
      lines.push("````");
    }
    lines.push("");
  }
  lines.push("</details>");
  lines.push("");
  return lines;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Build the full markdown stats block from the four raw inputs. Pure —
 * no filesystem access — so it is unit-testable without spawning. When
 * `aiCostRaw` parses to real cost data, that section leads and becomes
 * the authoritative token/dollar source; the chat-runner section then
 * drops its (cumulative-per-turn, non-summable) loop-log token bullet in
 * favour of a pointer.
 *
 * Section order is cost (headline optimization metric) → chat-runner stats
 * → per-scenario results (the verdict) → detected bugs (which qualify that
 * verdict: a green run can still have filed defects the AI worked around).
 */
export function buildReport(inputs: {
  log: string;
  reportRaw: string;
  aiCostRaw: string;
  bugsRaw: string;
}): string {
  const { log, reportRaw, aiCostRaw, bugsRaw } = inputs;

  const loops = parseChatRunnerLoops(log);
  const turns = countEnters(log);
  const { results, totalDurationMs } = parsePlaywrightReport(reportRaw);
  const cost = parseAiCost(aiCostRaw);
  const bugs = parseBugReports(bugsRaw);

  const totalLoops = loops.length;
  const totalToolCalls = loops.reduce((a, l) => a + l.toolCalls, 0);
  const totalTokensIn = loops.reduce((a, l) => a + l.tokensIn, 0);
  const totalTokensOut = loops.reduce((a, l) => a + l.tokensOut, 0);
  const stopReasons = new Map<string, number>();
  for (const l of loops) stopReasons.set(l.loopStop, (stopReasons.get(l.loopStop) ?? 0) + 1);
  const stopReasonStr =
    [...stopReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${v}× \`${k}\``)
      .join(", ") || "_no chat-runner loops recorded_";

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  const lines: string[] = [];
  // Real AI cost leads when captured — it's the headline optimization metric.
  lines.push(...formatCostSection(cost));
  lines.push("### Chat-runner API stats (this run)");
  lines.push("");
  if (turns === 0 && totalLoops === 0) {
    lines.push("_No chat-runner activity recorded — DB-only scenarios or admin.log missing._");
  } else {
    lines.push(`- **${turns}** chat turns (\`[chat-runner] enter\` events)`);
    lines.push(`- **${totalLoops}** tool-call loops (\`[chat-runner] loop\` events)`);
    lines.push(`- **${totalToolCalls}** tool calls dispatched`);
    if (cost) {
      // Loop-log tokensIn is cumulative per turn (each loop re-sends the
      // whole conversation), so summing them double-counts. Real totals
      // live in the Real AI cost section above.
      lines.push("- Token + cost totals: see **Real AI cost** above (from `ai_calls`)");
    } else {
      lines.push(
        `- **${fmtTokens(totalTokensIn)}** tokens in / **${fmtTokens(totalTokensOut)}** tokens out (loop-log, cumulative per turn)`,
      );
    }
    lines.push(`- Loop-stop reasons: ${stopReasonStr}`);
  }
  lines.push("");
  lines.push("### Per-scenario results");
  lines.push("");
  if (results.length === 0) {
    lines.push("_No Playwright results parsed — playwright-report.json missing or empty._");
  } else {
    lines.push("| Scenario | Status | Duration | Attempt |");
    lines.push("| --- | --- | --- | --- |");
    for (const r of results) {
      const status = r.ok ? "✓ pass" : `✘ ${r.status}`;
      const attempt = r.retries === 0 ? "1st" : `retry #${r.retries}`;
      // Truncate the scenario title at 80 chars so the table doesn't
      // wrap awkwardly on narrow GitHub viewports.
      const title = r.title.length > 80 ? `${r.title.slice(0, 77)}…` : r.title;
      lines.push(`| ${title} | ${status} | ${fmtMs(r.durationMs)} | ${attempt} |`);
    }
    lines.push("");
    lines.push(
      `**Total:** ${passed} passed, ${failed} failed in ${fmtMs(totalDurationMs)} wall-clock.`,
    );
  }
  lines.push("");
  lines.push(...formatBugSection(bugs));

  return lines.join("\n");
}

function main(): void {
  const log = existsSync(ADMIN_LOG) ? readFileSync(ADMIN_LOG, "utf8") : "";
  const reportRaw = existsSync(REPORT_JSON) ? readFileSync(REPORT_JSON, "utf8") : "";
  const aiCostRaw = existsSync(AI_COST_JSON) ? readFileSync(AI_COST_JSON, "utf8") : "";
  const bugsRaw = existsSync(BUG_REPORTS_JSON) ? readFileSync(BUG_REPORTS_JSON, "utf8") : "";
  process.stdout.write(buildReport({ log, reportRaw, aiCostRaw, bugsRaw }));
}

// Only run when invoked directly (not when imported by the unit test).
if (import.meta.main) main();
