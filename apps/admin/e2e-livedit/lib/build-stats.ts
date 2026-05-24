// SPDX-License-Identifier: MPL-2.0

/**
 * Emits a markdown stats summary for the e2e-livedit run. Reads
 *
 *   apps/admin/test-results/livedit/admin.log          (chat-runner stderr)
 *   apps/admin/test-results/livedit/playwright-report.json
 *
 * and writes a self-contained markdown block to stdout. The workflow
 * captures it and splices it into the sticky PR comment alongside the
 * screenshots + the per-test error blocks (PR #61).
 *
 * NOT a Playwright reporter — those run in the test process and would
 * have to share state with the suite. This is a separate post-process
 * that's easier to evolve.
 */

import { existsSync, readFileSync } from "node:fs";

const ADMIN_LOG = "apps/admin/test-results/livedit/admin.log";
const REPORT_JSON = "apps/admin/test-results/livedit/playwright-report.json";

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
          const last = test.results[test.results.length - 1]!;
          const status = last.status ?? "unknown";
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

function main(): void {
  const log = existsSync(ADMIN_LOG) ? readFileSync(ADMIN_LOG, "utf8") : "";
  const reportRaw = existsSync(REPORT_JSON) ? readFileSync(REPORT_JSON, "utf8") : "";

  const loops = parseChatRunnerLoops(log);
  const turns = countEnters(log);
  const { results, totalDurationMs } = parsePlaywrightReport(reportRaw);

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
  lines.push("### Chat-runner API stats (this run)");
  lines.push("");
  if (turns === 0 && totalLoops === 0) {
    lines.push("_No chat-runner activity recorded — DB-only scenarios or admin.log missing._");
  } else {
    lines.push(`- **${turns}** chat turns (\`[chat-runner] enter\` events)`);
    lines.push(`- **${totalLoops}** tool-call loops (\`[chat-runner] loop\` events)`);
    lines.push(`- **${totalToolCalls}** tool calls dispatched`);
    lines.push(
      `- **${fmtTokens(totalTokensIn)}** tokens in / **${fmtTokens(totalTokensOut)}** tokens out`,
    );
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

  process.stdout.write(lines.join("\n"));
}

main();
