// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — the scale-gate load: 20 MCP agents doing translation-shaped
 * work and 5 editors in Live Mode, against a running admin seeded by
 * `fixture.ts`. Measures the SLOs of docs/dev/scale-gate.md and exits
 * non-zero when one is missed (unless `--baseline`, which only records).
 *
 *   bun scripts/scale-gate/run.ts --fixture scale-gate-fixture.json \
 *     --base-url http://localhost:4391 --duration 300 \
 *     --admin-log admin.log --pg-log postgres.log --report scale-gate-report.json
 *
 * Agents work one page at a time with the full context, no batching
 * (#1253 decisions): read the page (`inspect_page_render`), create its
 * German variant (`create_variant`), write the translated content
 * (`set_page_module_content_many`). Editors open `/edit` (first paint =
 * the HTML document up to `</html>`, every awaited load done; the streamed
 * parts that follow are not timed, #1268), preview a page
 * (`preview-by-path`) and preview it again unchanged.
 *
 * Every call has a timeout, so a run against a slow build still finishes
 * and records numbers: a timed-out call counts as a sample at the timeout
 * and is counted separately.
 *
 * #1390 — beside the timings the run watches the cause of the 2026-11-03
 * production stall (observe.ts): the database container's CPU against its
 * share (`--pg-container`), every shipped plugin running before the load
 * starts (`list_plugins`), their change consumers past their first rebuild
 * (`--settle-consumers`, reads ADMIN_DATABASE_URL), the scheduler tick
 * driven like the install's scheduler at its shortest interval
 * (`--tick-every`, signs with CAELO_INTERNAL_SECRET) so every plugin
 * worker runs during the load, and every plugin failure in the admin log.
 * A plugin failure, a failed worker run or a failed tick fails the gate.
 */

import { readFileSync, statSync } from "node:fs";
import { SQL } from "bun";
import { mintTickToken } from "../../packages/admin-core/src/scheduler/clock.ts";
import type { ScaleGateFixture } from "./fixture.ts";
import {
  addTick,
  countPluginFailures,
  type DbCpuSummary,
  resetStatementStats,
  type StatementCost,
  samplePluginFailures,
  startCpuSampler,
  type TickSummary,
  type TickTaskRun,
  topStatements,
} from "./observe.ts";
import { groupSlowPlans, parseLoggedPlans, type SlowPlanGroup } from "./plans.ts";
import { CHANGE_CONSUMER_SLUGS, SHIPPED_PLUGIN_SLUGS } from "./plugins.ts";

/** The measurement classes and their p95 targets (ms), issue #1267. */
export const SLO_P95_MS = {
  first_paint: 1000,
  preview: 1500,
  unchanged_preview: 200,
  mcp_write: 1000,
  mcp_read: 500,
} as const;

/** One measurement class. */
export type Measurement = keyof typeof SLO_P95_MS;

/** Summary of one measurement class. */
export interface MeasurementSummary {
  readonly count: number;
  readonly errors: number;
  readonly timeouts: number;
  /** Calls the admin refused with 429 (back-pressure) before running them; each was retried. */
  readonly refused: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly targetP95: number;
  readonly pass: boolean;
}

/** The report a run writes. */
export interface ScaleGateReport {
  readonly startedAt: string;
  readonly durationSeconds: number;
  readonly pages: number;
  readonly agents: number;
  readonly editors: number;
  readonly callTimeoutMs: number;
  readonly measurements: Record<Measurement, MeasurementSummary>;
  readonly variantsCreated: number;
  readonly poolAcquireTimeouts: number;
  readonly lockWaitsOver100ms: number;
  /** #1390 — the database container's CPU during the load; null without `--pg-container`. */
  readonly dbCpu: DbCpuSummary | null;
  /**
   * The statements that took the most database time while the plugins
   * settled and during the load (`pg_stat_statements`, reset at the start
   * of each); null without `--pg-container`. Where the CPU went.
   */
  readonly dbStatements: {
    readonly settle: readonly StatementCost[] | null;
    readonly load: readonly StatementCost[] | null;
  };
  /**
   * #1269 — the plans of the statements over `auto_explain`'s
   * `log_min_duration`, per phase, grouped by text (`plans.ts`); null
   * without `--pg-log`. Why the heaviest statements cost what they cost.
   */
  readonly slowPlans: {
    readonly settle: readonly SlowPlanGroup[] | null;
    readonly load: readonly SlowPlanGroup[] | null;
  };
  /** #1390 — the shipped plugins and what went wrong in their background work. */
  readonly plugins: {
    readonly expected: readonly string[];
    /** Seconds waited for the change consumers' first rebuild; null = not waited for. */
    readonly settleSeconds: number | null;
    /** Whether they finished it within `--settle-timeout` (false fails the gate). */
    readonly settled: boolean | null;
    /** Failure lines in the admin log during the load, per plugin slug. */
    readonly failures: Record<string, number>;
    readonly sampleFailures: readonly string[];
    /** Scheduler ticks made during the load and the plugin worker runs they reported. */
    readonly ticks: TickSummary | null;
  };
  readonly pass: boolean;
  /** First few distinct error messages, for diagnosis. */
  readonly sampleErrors: readonly string[];
}

/**
 * A pool acquire that timed out, as the admin logs it (the error class) or
 * answers it (the operator-facing message of `PoolAcquireTimeoutError`).
 */
export const POOL_EXHAUSTED = /PoolAcquireTimeoutError|pool had no free connection/;

/** A call the admin refused (429) that could not be sent again before the deadline. */
const NOT_RUN = Symbol("not run");

/** A 429 from the admin: the call did not run and is to be sent again. */
class BackPressure extends Error {}

/**
 * Seconds a 429 answer asks the client to wait ("Wait 5 s, then send the
 * same call again"); 5 when it names none.
 */
export function retryAfterSeconds(body: string): number {
  const n = Number.parseInt(/Wait (\d+) s\b/.exec(body)?.[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/**
 * #1268 — reads an `/edit` document up to the end of its HTML and returns
 * that text. SvelteKit appends the load's streamed parts to the same
 * response after `</html>`, so first paint ends there; the rest drains in
 * the background and is not timed. Throws when the status is not 200 or
 * the response ends without `</html>`.
 */
export async function readFirstPaint(res: Response): Promise<string> {
  if (res.status !== 200)
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error("the response has no body");
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes("</html>")) {
      void (async () => {
        while (!(await reader.read()).done) {
          // Drain the streamed parts so the server finishes the response.
        }
      })().catch(() => undefined);
      return text;
    }
  }
  throw new Error(`the document ended without </html>: ${text.slice(0, 200)}`);
}

/** Nearest-rank percentile of sorted samples. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

/** Summarise one class's samples against its target. */
export function summarise(
  samples: readonly number[],
  errors: number,
  timeouts: number,
  targetP95: number,
  refused = 0,
): MeasurementSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  return {
    count: sorted.length,
    errors,
    timeouts,
    refused,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(p95),
    max: Math.round(sorted.at(-1) ?? 0),
    targetP95,
    // No sample is a failure too: a class the run never reached was not met.
    pass: sorted.length > 0 && errors === 0 && timeouts === 0 && refused === 0 && p95 < targetP95,
  };
}

/** Count lines matching `pattern` written to `path` after byte `fromByte`. */
export function countNewMatches(path: string | null, fromByte: number, pattern: RegExp): number {
  if (!path) return 0;
  const text = readFileSync(path).subarray(fromByte).toString("utf8");
  return text.split("\n").filter((line) => pattern.test(line)).length;
}

/** The slow-statement plans `path` gained between two byte offsets (to the end without `toByte`). */
function slowPlansBetween(
  path: string | null,
  fromByte: number,
  toByte?: number,
): SlowPlanGroup[] | null {
  if (!path) return null;
  const text = readFileSync(path).subarray(fromByte, toByte).toString("utf8");
  return groupSlowPlans(parseLoggedPlans(text), 10);
}

/** Markdown for one phase's slow plans: one collapsed block per statement. */
function slowPlanLines(phase: string, groups: readonly SlowPlanGroup[] | null): string[] {
  if (groups === null) return [];
  if (groups.length === 0) return ["", `Slow statement plans while ${phase}: none logged.`];
  return [
    "",
    `Slow statement plans while ${phase} (auto_explain, slowest occurrence each):`,
    ...groups.flatMap((g) => [
      "",
      `<details><summary>${g.count} × max ${g.maxMs} ms (total ${g.totalMs} ms): ${markdownCell(g.query.slice(0, 160)).replace(/</g, "&lt;")}</summary>`,
      "",
      "```",
      g.query,
      "",
      g.plan,
      "```",
      "",
      "</details>",
    ]),
  ];
}

function sizeOf(path: string | null): number {
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    throw new Error(`log file ${path} does not exist — pass the path the process writes to`);
  }
}

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/**
 * `text` as one markdown table cell: backslashes, pipes and backticks
 * escaped, line breaks flattened (a statement may contain all of them).
 */
export function markdownCell(text: string): string {
  return text.replace(/[\\|`]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, " ");
}

/** Markdown lines for the heaviest statements of one phase. */
function statementLines(phase: string, top: readonly StatementCost[] | null): string[] {
  if (top === null) return [];
  return [
    "",
    `Heaviest statements while ${phase} (pg_stat_statements):`,
    "",
    "| total ms | calls | mean ms | rows | buffers | statement |",
    "|---|---|---|---|---|---|",
    ...top
      .slice(0, 10)
      .map(
        (t) =>
          `| ${t.totalMs} | ${t.calls} | ${t.meanMs} | ${t.rows} | ${t.buffers} | ${markdownCell(t.query.slice(0, 160))} |`,
      ),
  ];
}

/** Markdown table of a report. */
export function reportTable(r: ScaleGateReport): string {
  const rows = (Object.keys(SLO_P95_MS) as Measurement[]).map((m) => {
    const s = r.measurements[m];
    return `| ${m} | ${s.count} | ${s.p50} | ${s.p95} | ${s.max} | ${s.errors} | ${s.timeouts} | ${s.refused} | < ${s.targetP95} | ${s.pass ? "pass" : "FAIL"} |`;
  });
  const cpu = r.dbCpu;
  const cpuLines = cpu
    ? [
        "",
        "| DB CPU | share | mean | p95 | max | samples at ≥ 95 % of share | throttled periods |",
        "|---|---|---|---|---|---|---|",
        `| ${cpu.container} (${cpu.samples} × ${cpu.intervalSeconds} s) | ${cpu.share ?? "unlimited"} | ${cpu.meanCpus} | ${cpu.p95Cpus} | ${cpu.maxCpus} | ${cpu.saturatedSamplesPct} % | ${cpu.meanThrottledPeriodsPct} % |`,
      ]
    : ["", "DB CPU: not sampled (no --pg-container)."];
  const workers = Object.entries(r.plugins.ticks?.workers ?? {});
  const pluginLines = [
    "",
    `Plugins active: ${r.plugins.expected.join(", ")}. Change consumers: ${r.plugins.settleSeconds === null ? "not waited for" : `${r.plugins.settled ? "settled" : "NOT settled"} after ${r.plugins.settleSeconds} s`}.`,
    `Plugin failures in the admin log: ${pluginFailureTotal(r.plugins.failures) === 0 ? "none" : JSON.stringify(r.plugins.failures)}.`,
    ...(r.plugins.ticks
      ? [
          `Scheduler ticks: ${r.plugins.ticks.ticks} (${r.plugins.ticks.tickErrors} failed). Worker runs: ${
            workers.length === 0
              ? "none"
              : workers
                  .map(
                    ([k, w]) =>
                      `${k} ${w.runs}×${w.failed > 0 ? ` (${w.failed} failed)` : ""} max ${w.maxMs} ms`,
                  )
                  .join("; ")
          }.`,
        ]
      : ["Scheduler ticks: not driven (no --tick-every)."]),
  ];
  return [
    `Fixture: ${r.pages} pages, ${r.agents} agents, ${r.editors} editors, ${r.durationSeconds} s, call timeout ${r.callTimeoutMs} ms`,
    "",
    "| measurement | n | p50 ms | p95 ms | max ms | errors | timeouts | refused (429) | target p95 | |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    ...cpuLines,
    ...statementLines("settling the plugins", r.dbStatements.settle),
    ...statementLines("the load", r.dbStatements.load),
    ...slowPlanLines("settling the plugins", r.slowPlans.settle),
    ...slowPlanLines("the load", r.slowPlans.load),
    ...pluginLines,
    "",
    `Variants created: ${r.variantsCreated}. Pool-acquire timeouts: ${r.poolAcquireTimeouts}. Lock waits > 100 ms: ${r.lockWaitsOver100ms}. Overall: ${r.pass ? "pass" : "FAIL"}.`,
  ].join("\n");
}

/** All plugin failure lines of a run. */
export function pluginFailureTotal(failures: Record<string, number>): number {
  return Object.values(failures).reduce((s, n) => s + n, 0);
}

/**
 * Whether the plugins' background work held: no failure line in the admin
 * log, no failed tick, no failed worker run.
 */
export function pluginsPass(failures: Record<string, number>, ticks: TickSummary | null): boolean {
  if (pluginFailureTotal(failures) > 0) return false;
  if (!ticks) return true;
  return ticks.tickErrors === 0 && Object.values(ticks.workers).every((w) => w.failed === 0);
}

/**
 * The slugs `list_plugins` does not report as `running`. The tool answers
 * one comma-separated row per plugin (`slug,status,version,health,…`); a
 * row counts when one cell is the slug and one is `running`.
 */
export function notRunning(listPluginsContent: string, slugs: readonly string[]): string[] {
  const running = new Set<string>();
  for (const line of listPluginsContent.split("\n")) {
    const cells = line.split(",").map((c) => c.trim());
    if (!cells.includes("running")) continue;
    for (const slug of slugs) if (cells.includes(slug)) running.add(slug);
  }
  return slugs.filter((s) => !running.has(s));
}

/**
 * Refuse to start the load until `list_plugins` reports every shipped
 * plugin `running` (the heartbeat may take a moment after boot). A gate
 * run with a plugin missing would measure less than production runs.
 */
async function assertPluginsRunning(
  baseUrl: string,
  fixture: ScaleGateFixture,
  timeoutMs: number,
): Promise<void> {
  const token = fixture.mcpTokens[0];
  if (!token) throw new Error("fixture has no MCP token");
  const headers = { "content-type": "application/json", "x-caelo-mcp-token": token };
  const opened = await fetch(`${baseUrl}/api/mcp/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ newSession: true, title: "Scale-gate preflight" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!opened.ok)
    throw new Error(`preflight: open session ${opened.status} ${await opened.text()}`);
  const chatSessionId = ((await opened.json()) as { chatSessionId: string }).chatSessionId;
  const until = Date.now() + 120_000;
  let content = "";
  for (;;) {
    const res = await fetch(`${baseUrl}/api/mcp/tool`, {
      method: "POST",
      headers,
      body: JSON.stringify({ toolName: "list_plugins", args: {}, chatSessionId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`preflight: list_plugins HTTP ${res.status} ${text}`);
    content = (JSON.parse(text) as { content: string }).content;
    const missing = notRunning(content, SHIPPED_PLUGIN_SLUGS);
    if (missing.length === 0) return;
    if (Date.now() > until) {
      throw new Error(
        `preflight: shipped plugins not running after 120 s: ${missing.join(", ")}\n${content}`,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Wait until the change consumer of every plugin that declares one has
 * finished its first rebuild and has no paged read in progress.
 *
 * @returns seconds waited and whether they settled within `timeoutS`
 */
async function settle(
  adminDbUrl: string,
  timeoutS: number,
): Promise<{ seconds: number; settled: boolean; state: string }> {
  const sql = new SQL(adminDbUrl, { max: 1 });
  const started = Date.now();
  let state = "";
  try {
    for (;;) {
      // change_consumers is system-scoped (RLS, migration 0430).
      const rows = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return tx`
          SELECT p.slug, c.name IS NOT NULL AS registered,
                 coalesce(c.rebuild_pending, true) AS rebuild_pending,
                 c.page_target IS NOT NULL AS paging
          FROM plugins p LEFT JOIN change_consumers c ON c.plugin_id = p.id
          WHERE p.slug IN ${tx(CHANGE_CONSUMER_SLUGS as string[])}`;
      })) as unknown as {
        slug: string;
        registered: boolean;
        rebuild_pending: boolean;
        paging: boolean;
      }[];
      state = rows
        .map(
          (r) =>
            `${r.slug}: ${!r.registered ? "not registered" : r.rebuild_pending ? "rebuilding" : r.paging ? "reading" : "settled"}`,
        )
        .join(", ");
      const seconds = Math.round((Date.now() - started) / 1000);
      if (
        rows.length === CHANGE_CONSUMER_SLUGS.length &&
        rows.every((r) => r.registered && !r.rebuild_pending && !r.paging)
      ) {
        return { seconds, settled: true, state };
      }
      if (seconds > timeoutS) return { seconds, settled: false, state };
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    await sql.end();
  }
}

/**
 * Call the scheduler tick every `everyS` seconds while `running()`, like
 * the install's scheduler (the self-hosted clock's own call). The first
 * tick comes at once: a worker the due-table has never seen is due then.
 * The tick in flight when the load ends is awaited, so its worker runs
 * are counted.
 */
/** A tick's budget (4 min, tick.ts) plus one worker's lease (5 min). */
const TICK_TIMEOUT_MS = 9 * 60 * 1000;

async function driveTicks(
  baseUrl: string,
  secret: string,
  everyS: number,
  running: () => boolean,
): Promise<{ summary: TickSummary; errorSamples: string[] }> {
  const summary = { ticks: 0, tickErrors: 0, workers: {}, coreFailures: [] as string[] };
  const errorSamples: string[] = [];
  while (running()) {
    const started = Date.now();
    try {
      // The self-hosted clock's call (clock.ts), reading the whole answer:
      // the per-task outcomes are what the gate counts.
      const res = await fetch(`${baseUrl}/api/internal/scheduler/tick`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await mintTickToken(secret)}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(TICK_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`tick answered HTTP ${res.status}: ${text.slice(0, 300)}`);
      const body = JSON.parse(text) as { ran?: TickTaskRun[] };
      const ran = body.ran ?? [];
      addTick(summary, ran);
      for (const r of ran) {
        if (r.key.startsWith("plugin:") && r.outcome !== "ok" && errorSamples.length < 8) {
          errorSamples.push(`${r.key} ${r.outcome}: ${(r.detail ?? "").slice(0, 300)}`);
        }
      }
    } catch (e) {
      summary.ticks += 1;
      summary.tickErrors += 1;
      if (errorSamples.length < 8) errorSamples.push((e as Error).message.slice(0, 300));
    }
    while (running() && Date.now() - started < everyS * 1000) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { summary, errorSamples };
}

async function main(): Promise<void> {
  const fixturePath = arg("--fixture") ?? "scale-gate-fixture.json";
  const baseUrl = (arg("--base-url") ?? process.env.BASE_URL ?? "http://localhost:4391").replace(
    /\/$/,
    "",
  );
  const durationS = Number.parseInt(arg("--duration") ?? process.env.DURATION ?? "300", 10);
  const timeoutMs = Number.parseInt(arg("--call-timeout") ?? "30000", 10);
  const adminLog = arg("--admin-log");
  const pgLog = arg("--pg-log");
  const reportPath = arg("--report") ?? "scale-gate-report.json";
  const baseline = process.argv.includes("--baseline");
  const pgContainer = arg("--pg-container");
  const cpuIntervalS = Number.parseInt(arg("--cpu-interval") ?? "5", 10);
  const tickEveryS = Number.parseInt(arg("--tick-every") ?? "0", 10);
  const settleConsumers = process.argv.includes("--settle-consumers");
  const settleTimeoutS = Number.parseInt(arg("--settle-timeout") ?? "900", 10);
  const internalSecret = process.env.CAELO_INTERNAL_SECRET ?? "";
  if (tickEveryS > 0 && internalSecret.length < 32) {
    throw new Error(
      "--tick-every signs the scheduler tick with CAELO_INTERNAL_SECRET (the admin's, ≥ 32 characters)",
    );
  }
  const adminDbUrl = process.env.ADMIN_DATABASE_URL ?? "";
  if (settleConsumers && !adminDbUrl) {
    throw new Error("--settle-consumers reads the change consumers through ADMIN_DATABASE_URL");
  }
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ScaleGateFixture;

  const samples: Record<Measurement, number[]> = {
    first_paint: [],
    preview: [],
    unchanged_preview: [],
    mcp_write: [],
    mcp_read: [],
  };
  const errors: Record<Measurement, number> = {
    first_paint: 0,
    preview: 0,
    unchanged_preview: 0,
    mcp_write: 0,
    mcp_read: 0,
  };
  const timeouts: Record<Measurement, number> = { ...errors };
  const refusals: Record<Measurement, number> = { ...errors };
  const sampleErrors = new Set<string>();
  let poolRefusals = 0;
  const noteError = (m: Measurement, message: string) => {
    errors[m] += 1;
    if (POOL_EXHAUSTED.test(message)) poolRefusals += 1;
    if (sampleErrors.size < 12) sampleErrors.add(`${m}: ${message.slice(0, 300)}`);
  };

  /**
   * Time one call. `check` reads the response and throws on a failure the
   * status does not show (an MCP tool answering ok: false).
   */
  async function timed<T>(
    m: Measurement,
    url: string,
    init: RequestInit,
    check: (res: Response) => Promise<T>,
    t0: number = performance.now(),
  ): Promise<T | null> {
    try {
      const res = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const value = await check(res);
      samples[m].push(performance.now() - t0);
      return value;
    } catch (e) {
      const name = (e as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        samples[m].push(timeoutMs);
        timeouts[m] += 1;
        return null;
      }
      // A refusal is no sample: the caller waits and sends the call again.
      if (e instanceof BackPressure) return null;
      samples[m].push(performance.now() - t0);
      noteError(m, (e as Error).message);
      return null;
    }
  }

  // --- Before the load (#1390): every shipped plugin runs, and its change
  // consumer is past the first rebuild a fresh activation starts with
  // (a one-off over the whole site; the gate measures the steady state).
  // A plugin failure while the consumers settle counts too.
  const pluginLogStart = sizeOf(adminLog);
  await assertPluginsRunning(baseUrl, fixture, timeoutMs);
  if (pgContainer) await resetStatementStats(pgContainer);
  const pgSettleStart = sizeOf(pgLog);
  const settled = settleConsumers ? await settle(adminDbUrl, settleTimeoutS) : null;
  const settleStatements = pgContainer ? await topStatements(pgContainer, 15) : null;
  if (settled) {
    console.log(
      `[scale-gate] change consumers ${settled.settled ? "settled" : "NOT settled"} after ${settled.seconds} s (${settled.state})`,
    );
  }

  let deadline = 0;
  const adminLogStart = sizeOf(adminLog);
  const pgLogStart = sizeOf(pgLog);
  const startedAt = new Date().toISOString();
  let variantsCreated = 0;

  // The work queue: each untranslated English page is taken by one agent.
  const queue = [...fixture.untranslated];

  async function agent(index: number): Promise<void> {
    const token = fixture.mcpTokens[index];
    if (!token) throw new Error(`fixture has no MCP token for agent ${index}`);
    const headers = { "content-type": "application/json", "x-caelo-mcp-token": token };
    const opened = await fetch(`${baseUrl}/api/mcp/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ newSession: true, title: `Scale-gate agent ${index + 1}` }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!opened.ok)
      throw new Error(`agent ${index}: open session ${opened.status} ${await opened.text()}`);
    const chatSessionId = ((await opened.json()) as { chatSessionId: string }).chatSessionId;
    // An agent obeys back-pressure as a real MCP client does (#1375): a 429
    // says how long to wait, and the same call is sent again unchanged. The
    // sample is the whole time until the call ran, waits included; each
    // refusal is counted on its own.
    const tool = async (m: Measurement, toolName: string, args: unknown) => {
      const t0 = performance.now();
      for (;;) {
        let refusedFor: number | null = null;
        const value = await timed(
          m,
          `${baseUrl}/api/mcp/tool`,
          { method: "POST", headers, body: JSON.stringify({ toolName, args, chatSessionId }) },
          async (res) => {
            const text = await res.text();
            if (res.status === 429) {
              refusedFor = retryAfterSeconds(text);
              throw new BackPressure();
            }
            if (!res.ok) throw new Error(`${toolName}: HTTP ${res.status} ${text}`);
            const body = JSON.parse(text) as { ok: boolean; content: string };
            if (!body.ok) throw new Error(`${toolName}: ${body.content}`);
            return body.content;
          },
          t0,
        );
        if (refusedFor === null) return value;
        refusals[m] += 1;
        // Out of time to retry: the call never ran, so the agent stops here
        // rather than go on to a step that needs it (a write after a refused read).
        if (Date.now() + refusedFor * 1000 >= deadline) return NOT_RUN;
        await Bun.sleep(refusedFor * 1000);
      }
    };
    while (Date.now() < deadline) {
      const page = queue.shift();
      if (!page) return;
      if ((await tool("mcp_read", "inspect_page_render", { pageId: page.id })) === NOT_RUN) return;
      if (Date.now() >= deadline) return;
      const slug = `${page.path.replace(/^\//, "")}-de`;
      const created = await tool("mcp_write", "create_variant", {
        sourcePageId: page.id,
        localeCode: "de",
        slug,
      });
      if (created === NOT_RUN) return;
      if (created === null || Date.now() >= deadline) continue;
      const variantId = /"(?:pageId|variantPageId|newPageId)"\s*:\s*"([0-9a-f-]{36})"/.exec(
        created,
      )?.[1];
      if (!variantId) {
        noteError("mcp_write", `create_variant answered without a page id: ${created}`);
        continue;
      }
      variantsCreated += 1;
      await tool("mcp_write", "set_page_module_content_many", {
        items: [
          {
            pageId: variantId,
            blockName: "content",
            position: 0,
            contentValues: {
              heading: `Übersetzt: ${slug}`,
              body: `<p>${"Lorem ipsum auf Deutsch. ".repeat(20)}</p>`,
            },
          },
        ],
      });
    }
  }

  async function editor(index: number): Promise<void> {
    const e = fixture.editors[index];
    if (!e) throw new Error(`fixture has no editor ${index}`);
    const headers = { cookie: `caelo_session=${e.sessionToken}` };
    const readAll = async (res: Response) => {
      const text = await res.text();
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return text;
    };
    let i = index;
    while (Date.now() < deadline) {
      const page = fixture.editorPages[(i * 7) % fixture.editorPages.length];
      i += 1;
      if (!page) return;
      await timed(
        "first_paint",
        `${baseUrl}/edit?page=${page.id}&chat=${e.chatSessionId}`,
        { headers },
        readFirstPaint,
      );
      if (Date.now() >= deadline) return;
      const preview = `${baseUrl}/edit/preview-by-path${page.path}?branch=${fixture.draftBranchId}`;
      await timed("preview", preview, { headers }, readAll);
      if (Date.now() >= deadline) return;
      await timed("unchanged_preview", preview, { headers }, readAll);
    }
  }

  const agents = fixture.mcpTokens.length;
  const editors = fixture.editors.length;
  console.log(
    `[scale-gate] ${agents} agents + ${editors} editors against ${baseUrl} for ${durationS} s (${fixture.pages} pages)`,
  );
  if (pgContainer) await resetStatementStats(pgContainer);
  const sampler = pgContainer ? await startCpuSampler(pgContainer, cpuIntervalS) : null;
  deadline = Date.now() + durationS * 1000;
  const ticks =
    tickEveryS > 0
      ? driveTicks(baseUrl, internalSecret, tickEveryS, () => Date.now() < deadline)
      : null;
  const results = await Promise.allSettled([
    ...Array.from({ length: agents }, (_, i) => agent(i)),
    ...Array.from({ length: editors }, (_, i) => editor(i)),
  ]);
  const dbCpu = sampler ? await sampler.stop() : null;
  const loadStatements = pgContainer ? await topStatements(pgContainer, 15) : null;
  const tickSummary = ticks ? await ticks : null;
  for (const r of results) {
    if (r.status === "rejected") {
      throw new Error(`a load loop could not start: ${(r.reason as Error).message}`);
    }
  }
  const pluginLog = adminLog
    ? readFileSync(adminLog).subarray(pluginLogStart).toString("utf8")
    : "";
  const pluginFailures = countPluginFailures(pluginLog);
  for (const line of tickSummary?.errorSamples ?? []) {
    if (sampleErrors.size < 16) sampleErrors.add(`tick: ${line}`);
  }

  const measurements = Object.fromEntries(
    (Object.keys(SLO_P95_MS) as Measurement[]).map((m) => [
      m,
      summarise(samples[m], errors[m], timeouts[m], SLO_P95_MS[m], refusals[m]),
    ]),
  ) as Record<Measurement, MeasurementSummary>;
  // A refusal the admin also logged would count twice; take the larger view.
  const poolAcquireTimeouts = Math.max(
    poolRefusals,
    countNewMatches(adminLog, adminLogStart, POOL_EXHAUSTED),
  );
  const lockWaitsOver100ms = countNewMatches(pgLog, pgLogStart, /still waiting for/);
  const report: ScaleGateReport = {
    startedAt,
    durationSeconds: durationS,
    pages: fixture.pages,
    agents,
    editors,
    callTimeoutMs: timeoutMs,
    measurements,
    variantsCreated,
    poolAcquireTimeouts,
    lockWaitsOver100ms,
    dbCpu,
    dbStatements: { settle: settleStatements, load: loadStatements },
    slowPlans: {
      settle: slowPlansBetween(pgLog, pgSettleStart, pgLogStart),
      load: slowPlansBetween(pgLog, pgLogStart),
    },
    plugins: {
      expected: SHIPPED_PLUGIN_SLUGS,
      settleSeconds: settled?.seconds ?? null,
      settled: settled ? settled.settled : null,
      failures: pluginFailures,
      sampleFailures: samplePluginFailures(pluginLog, 12),
      ticks: tickSummary ? tickSummary.summary : null,
    },
    pass:
      Object.values(measurements).every((s) => s.pass) &&
      poolAcquireTimeouts === 0 &&
      lockWaitsOver100ms === 0 &&
      settled?.settled !== false &&
      pluginsPass(pluginFailures, tickSummary ? tickSummary.summary : null),
    sampleErrors: [...sampleErrors],
  };
  await Bun.write(reportPath, JSON.stringify(report, null, 2));
  console.log(reportTable(report));
  if (report.sampleErrors.length > 0) {
    console.log(`\nSample errors:\n${report.sampleErrors.map((s) => `- ${s}`).join("\n")}`);
  }
  if (report.plugins.sampleFailures.length > 0) {
    console.log(
      `\nPlugin failures:\n${report.plugins.sampleFailures.map((s) => `- ${s}`).join("\n")}`,
    );
  }
  if (!report.pass && !baseline) process.exit(1);
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
