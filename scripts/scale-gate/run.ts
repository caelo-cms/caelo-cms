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
 * the whole HTML document, every awaited load done), preview a page
 * (`preview-by-path`) and preview it again unchanged.
 *
 * Every call has a timeout, so a run against a slow build still finishes
 * and records numbers: a timed-out call counts as a sample at the timeout
 * and is counted separately.
 */

import { readFileSync, statSync } from "node:fs";
import type { ScaleGateFixture } from "./fixture.ts";

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
  readonly pass: boolean;
  /** First few distinct error messages, for diagnosis. */
  readonly sampleErrors: readonly string[];
}

/**
 * A pool acquire that timed out, as the admin logs it (the error class) or
 * answers it (the operator-facing message of `PoolAcquireTimeoutError`).
 */
export const POOL_EXHAUSTED = /PoolAcquireTimeoutError|pool had no free connection/;

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
): MeasurementSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  return {
    count: sorted.length,
    errors,
    timeouts,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(p95),
    max: Math.round(sorted.at(-1) ?? 0),
    targetP95,
    // No sample is a failure too: a class the run never reached was not met.
    pass: sorted.length > 0 && errors === 0 && timeouts === 0 && p95 < targetP95,
  };
}

/** Count lines matching `pattern` written to `path` after byte `fromByte`. */
export function countNewMatches(path: string | null, fromByte: number, pattern: RegExp): number {
  if (!path) return 0;
  const text = readFileSync(path).subarray(fromByte).toString("utf8");
  return text.split("\n").filter((line) => pattern.test(line)).length;
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

/** Markdown table of a report. */
export function reportTable(r: ScaleGateReport): string {
  const rows = (Object.keys(SLO_P95_MS) as Measurement[]).map((m) => {
    const s = r.measurements[m];
    return `| ${m} | ${s.count} | ${s.p50} | ${s.p95} | ${s.max} | ${s.errors} | ${s.timeouts} | < ${s.targetP95} | ${s.pass ? "pass" : "FAIL"} |`;
  });
  return [
    `Fixture: ${r.pages} pages, ${r.agents} agents, ${r.editors} editors, ${r.durationSeconds} s, call timeout ${r.callTimeoutMs} ms`,
    "",
    "| measurement | n | p50 ms | p95 ms | max ms | errors | timeouts | target p95 | |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    `Variants created: ${r.variantsCreated}. Pool-acquire timeouts: ${r.poolAcquireTimeouts}. Lock waits > 100 ms: ${r.lockWaitsOver100ms}. Overall: ${r.pass ? "pass" : "FAIL"}.`,
  ].join("\n");
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
  ): Promise<T | null> {
    const t0 = performance.now();
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
      samples[m].push(performance.now() - t0);
      noteError(m, (e as Error).message);
      return null;
    }
  }

  const deadline = Date.now() + durationS * 1000;
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
    const tool = (m: Measurement, toolName: string, args: unknown) =>
      timed(
        m,
        `${baseUrl}/api/mcp/tool`,
        { method: "POST", headers, body: JSON.stringify({ toolName, args, chatSessionId }) },
        async (res) => {
          const text = await res.text();
          if (!res.ok) throw new Error(`${toolName}: HTTP ${res.status} ${text}`);
          const body = JSON.parse(text) as { ok: boolean; content: string };
          if (!body.ok) throw new Error(`${toolName}: ${body.content}`);
          return body.content;
        },
      );
    while (Date.now() < deadline) {
      const page = queue.shift();
      if (!page) return;
      await tool("mcp_read", "inspect_page_render", { pageId: page.id });
      if (Date.now() >= deadline) return;
      const slug = `${page.path.replace(/^\//, "")}-de`;
      const created = await tool("mcp_write", "create_variant", {
        sourcePageId: page.id,
        localeCode: "de",
        slug,
      });
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
        readAll,
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
  const results = await Promise.allSettled([
    ...Array.from({ length: agents }, (_, i) => agent(i)),
    ...Array.from({ length: editors }, (_, i) => editor(i)),
  ]);
  for (const r of results) {
    if (r.status === "rejected") {
      throw new Error(`a load loop could not start: ${(r.reason as Error).message}`);
    }
  }

  const measurements = Object.fromEntries(
    (Object.keys(SLO_P95_MS) as Measurement[]).map((m) => [
      m,
      summarise(samples[m], errors[m], timeouts[m], SLO_P95_MS[m]),
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
    pass:
      Object.values(measurements).every((s) => s.pass) &&
      poolAcquireTimeouts === 0 &&
      lockWaitsOver100ms === 0,
    sampleErrors: [...sampleErrors],
  };
  await Bun.write(reportPath, JSON.stringify(report, null, 2));
  console.log(reportTable(report));
  if (report.sampleErrors.length > 0) {
    console.log(`\nSample errors:\n${report.sampleErrors.map((s) => `- ${s}`).join("\n")}`);
  }
  if (!report.pass && !baseline) process.exit(1);
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
