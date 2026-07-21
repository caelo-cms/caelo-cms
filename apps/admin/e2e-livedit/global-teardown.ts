// SPDX-License-Identifier: MPL-2.0

/**
 * e2e-livedit globalTeardown (issue #47).
 *
 * Reads the PID written by `global-setup.ts`, sends SIGTERM, and gives
 * the admin process a short grace window before SIGKILL. The
 * Playwright HTML reporter still has its own files under
 * `test-results/livedit/playwright-report/`; the admin's captured
 * stdout/stderr remain in `test-results/livedit/admin.log` for triage.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatReport, metricsBySession } from "./livedit-metrics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVEDIT_DIR = resolve(HERE, "../test-results/livedit");
const ADMIN_PID_PATH = resolve(LIVEDIT_DIR, "admin.pid");
const ADMIN_LOG = resolve(LIVEDIT_DIR, "admin.log");
const SCENARIO_METRICS_JSONL = resolve(LIVEDIT_DIR, "scenario-metrics.jsonl");
const METRICS_REPORT_TXT = resolve(LIVEDIT_DIR, "metrics-report.txt");
const METRICS_JSON = resolve(LIVEDIT_DIR, "metrics.json");
const SIGKILL_GRACE_MS = 5_000;

const k = (n: number): string => (Number.isFinite(n) ? `${(n / 1000).toFixed(1)}k` : "?");

/**
 * Consolidate every scenario's token/cache summary (one JSON line each,
 * written by `recordScenarioMetrics`) into two PR artifacts: a
 * machine-readable `metrics.json` and a human `metrics-report.txt` — so the
 * numbers are attached to every CI e2e run, not just visible in a live log.
 */
function writeMetricsArtifact(): void {
  if (!existsSync(SCENARIO_METRICS_JSONL)) return;
  const rows = readFileSync(SCENARIO_METRICS_JSONL, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((r): r is Record<string, unknown> => r !== null);

  // The complete per-session/turn/loop/tool breakdown, parsed from the FULL
  // admin.log — the authoritative source. Computed REGARDLESS of the named
  // jsonl summary, so a scenario that fails BEFORE recording its metrics
  // (e.g. a mid-test API error) still yields a full report for every
  // session that ran. This is the primary artifact.
  const detail: string[] = [];
  let sessionCount = 0;
  if (existsSync(ADMIN_LOG)) {
    const sessions = metricsBySession(readFileSync(ADMIN_LOG, "utf8"));
    sessionCount = sessions.length;
    for (const s of sessions) detail.push(formatReport(`session ${s.session.slice(0, 8)}`, s.metrics));
  }

  // Nothing ran (no named scenario recorded AND no chat sessions in the log).
  if (rows.length === 0 && sessionCount === 0) return;

  writeFileSync(METRICS_JSON, JSON.stringify(rows, null, 2));

  const lines: string[] = [
    "e2e-livedit token & cache metrics",
    "=".repeat(78),
    "",
    "scenario        | loops | input   | read    | hit% | write   | fresh%  | output",
    "-".repeat(78),
  ];
  if (rows.length === 0) {
    lines.push("(no scenario recorded a named summary — see per-session detail below)");
  }
  for (const r of rows) {
    const n = (key: string): number => (typeof r[key] === "number" ? (r[key] as number) : Number.NaN);
    lines.push(
      `${String(r.scenario ?? "?").padEnd(15)} | ${String(n("loops")).padStart(5)} | ` +
        `${k(n("inputTokens")).padStart(7)} | ${k(n("cacheRead")).padStart(7)} | ` +
        `${String(n("cacheHitPct")).padStart(4)} | ${k(n("cacheWrite")).padStart(7)} | ` +
        `${String(n("freshPct")).padStart(6)}% | ${k(n("output")).padStart(6)}`,
    );
  }

  const report = [...lines, "", "=".repeat(78), "PER-SESSION DETAIL", "=".repeat(78), ...detail].join(
    "\n",
  );
  writeFileSync(METRICS_REPORT_TXT, `${report}\n`);
  // eslint-disable-next-line no-console -- teardown summary for CI logs.
  console.log(`\n${lines.join("\n")}\n\n[metrics] wrote ${METRICS_JSON} + ${METRICS_REPORT_TXT}`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export default async function globalTeardown(): Promise<void> {
  // Emit the token/cache metrics artifact before tearing the admin down.
  try {
    writeMetricsArtifact();
  } catch {
    // Never let metrics reporting block teardown.
  }

  if (!existsSync(ADMIN_PID_PATH)) return;
  const raw = readFileSync(ADMIN_PID_PATH, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  unlinkSync(ADMIN_PID_PATH);
  if (!Number.isInteger(pid) || pid <= 1) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + SIGKILL_GRACE_MS;
  while (Date.now() < deadline && pidAlive(pid)) {
    await sleep(100);
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
