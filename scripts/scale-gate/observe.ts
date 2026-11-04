// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1390 — what the scale gate watches beside the request timings:
 * the database's CPU, the plugins' background work and the scheduler tick.
 *
 * On 2026-11-03 searchVIU production stalled on a db-f1-micro whose shared
 * core sat at its cap (0.20–0.25 of a vCPU) while a plugin's change
 * consumer ran site-sized reads after every agent write. The request
 * timings showed only the symptom; these readings show the cause:
 *
 * - **DB CPU**: the Postgres container's own cgroup (`cpu.stat`
 *   `usage_usec`, `nr_throttled`, `throttled_usec`; `cpu.max` for the
 *   share it runs under), sampled with `docker exec` while the load runs.
 *   Reported, never a pass/fail of its own: a saturated share is what the
 *   latency SLOs then fail on, and the report says why.
 * - **Plugin failures**: the plugin host's error lines in the admin log
 *   (`[plugin-host] <slug> <phase> failed (…)`, `change consumer of
 *   "<slug>" stopped`), and plugin worker runs the scheduler tick reports
 *   as failed. Any of them during the load fails the gate.
 */

import { spawn } from "node:child_process";

/** The CPU counters of one cgroup read. */
export interface CpuCounters {
  /** Microseconds of CPU the cgroup has used since it was created. */
  readonly usageUsec: number;
  /** Scheduler periods in which the cgroup hit its quota. */
  readonly nrThrottled: number;
  /** Microseconds the cgroup spent throttled. */
  readonly throttledUsec: number;
}

/** Parse a cgroup v2 `cpu.stat` file. Throws when `usage_usec` is missing. */
export function parseCpuStat(text: string): CpuCounters {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value && /^\d+$/.test(value)) values.set(key, Number(value));
  }
  const usageUsec = values.get("usage_usec");
  if (usageUsec === undefined) {
    throw new Error(`cpu.stat has no usage_usec (is the container on cgroup v2?): ${text}`);
  }
  return {
    usageUsec,
    nrThrottled: values.get("nr_throttled") ?? 0,
    throttledUsec: values.get("throttled_usec") ?? 0,
  };
}

/**
 * Parse a cgroup v2 `cpu.max` (`<quota> <period>` or `max <period>`) into
 * the share of one CPU the cgroup may use; null when unlimited.
 */
export function parseCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (quota === "max") return null;
  const q = Number(quota);
  const p = Number(period);
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0) {
    throw new Error(`cpu.max is not "<quota> <period>": ${JSON.stringify(text)}`);
  }
  return q / p;
}

/** One sampling interval: CPU used as a share of one CPU, and how much of it was throttled. */
export interface CpuSample {
  readonly atMs: number;
  /** CPU used in the interval, in CPUs (0.2 = a fifth of one CPU). */
  readonly cpus: number;
  /** Fraction of the interval's scheduler periods that hit the quota. */
  readonly throttledPeriods: number;
}

/** The interval between two reads. */
export function cpuSampleBetween(
  a: CpuCounters & { readonly atMs: number },
  b: CpuCounters & { readonly atMs: number },
  periodUsec: number,
): CpuSample {
  const wallUsec = (b.atMs - a.atMs) * 1000;
  if (wallUsec <= 0) throw new Error("CPU samples must be taken in order");
  const periods = wallUsec / periodUsec;
  return {
    atMs: b.atMs,
    cpus: (b.usageUsec - a.usageUsec) / wallUsec,
    throttledPeriods: periods > 0 ? Math.min(1, (b.nrThrottled - a.nrThrottled) / periods) : 0,
  };
}

/** The DB CPU section of the report. */
export interface DbCpuSummary {
  readonly container: string;
  /** The CPU share the container runs under (`cpu.max`); null = unlimited. */
  readonly share: number | null;
  readonly samples: number;
  readonly intervalSeconds: number;
  /** CPUs used, mean / p95 / max over the samples. */
  readonly meanCpus: number;
  readonly p95Cpus: number;
  readonly maxCpus: number;
  /** Samples at ≥ 95 % of the share: the database was CPU-bound. */
  readonly saturatedSamplesPct: number;
  /** Mean fraction of scheduler periods that hit the quota. */
  readonly meanThrottledPeriodsPct: number;
}

function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Summarise the samples of a run. */
export function summariseCpu(
  container: string,
  share: number | null,
  intervalSeconds: number,
  samples: readonly CpuSample[],
): DbCpuSummary {
  const cpus = samples.map((s) => s.cpus).sort((x, y) => x - y);
  const mean = cpus.length > 0 ? cpus.reduce((s, x) => s + x, 0) / cpus.length : 0;
  const saturated = share === null ? 0 : samples.filter((s) => s.cpus >= 0.95 * share).length;
  const throttled =
    samples.length > 0 ? samples.reduce((s, x) => s + x.throttledPeriods, 0) / samples.length : 0;
  return {
    container,
    share,
    samples: samples.length,
    intervalSeconds,
    meanCpus: round3(mean),
    p95Cpus: round3(nearestRank(cpus, 95)),
    maxCpus: round3(cpus.at(-1) ?? 0),
    saturatedSamplesPct: samples.length > 0 ? Math.round((100 * saturated) / samples.length) : 0,
    meanThrottledPeriodsPct: Math.round(100 * throttled),
  };
}

function dockerExec(container: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", container, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errText = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      errText += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`docker exec ${container} ${args.join(" ")}: exit ${code} ${errText}`));
    });
  });
}

/** One normalised statement's database cost over a phase (`pg_stat_statements`). */
export interface StatementCost {
  readonly database: string;
  readonly calls: number;
  readonly totalMs: number;
  readonly meanMs: number;
  readonly rows: number;
  readonly buffers: number;
  /** The normalised text, whitespace collapsed, cut at 400 characters. */
  readonly query: string;
}

/** psql in the database container as its superuser (the image's POSTGRES_USER). */
function psqlInContainer(container: string, statement: string): Promise<string> {
  return dockerExec(container, [
    "sh",
    "-c",
    'psql -X -q -At -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "$0"',
    statement,
  ]);
}

/**
 * Start a phase's statement statistics from zero. Fails loudly when the
 * extension is not loaded: a gate that cannot say where the database time
 * went hides what it is for.
 */
export async function resetStatementStats(container: string): Promise<void> {
  await psqlInContainer(
    container,
    "CREATE EXTENSION IF NOT EXISTS pg_stat_statements; SELECT pg_stat_statements_reset();",
  );
}

/** The `limit` statements with the most execution time since the last reset, heaviest first. */
export async function topStatements(container: string, limit: number): Promise<StatementCost[]> {
  const out = await psqlInContainer(
    container,
    `SELECT COALESCE(json_agg(t), '[]') FROM (
       SELECT d.datname AS database, s.calls::bigint AS calls,
              round(s.total_exec_time)::bigint AS "totalMs",
              round(s.mean_exec_time::numeric, 1)::float AS "meanMs",
              s.rows::bigint AS rows,
              (s.shared_blks_hit + s.shared_blks_read)::bigint AS buffers,
              left(regexp_replace(s.query, '\\s+', ' ', 'g'), 400) AS query
         FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid
        WHERE s.query NOT ILIKE '%pg_stat_statements%'
        ORDER BY s.total_exec_time DESC LIMIT ${Math.trunc(limit)}) t`,
  );
  return JSON.parse(out.trim() || "[]") as StatementCost[];
}

/**
 * Sample a container's CPU every `intervalSeconds` until `stop()` is
 * called. The first read fails loudly (no container, no cgroup v2): a
 * gate that silently reports no CPU would hide exactly what it is for.
 */
export async function startCpuSampler(
  container: string,
  intervalSeconds: number,
): Promise<{ stop: () => Promise<DbCpuSummary> }> {
  const read = async () => {
    const text = await dockerExec(container, ["cat", "/sys/fs/cgroup/cpu.stat"]);
    return { ...parseCpuStat(text), atMs: Date.now() };
  };
  const maxText = await dockerExec(container, ["cat", "/sys/fs/cgroup/cpu.max"]);
  const share = parseCpuMax(maxText);
  const periodUsec = Number(maxText.trim().split(/\s+/)[1] ?? "100000");
  const samples: CpuSample[] = [];
  let last = await read();
  let stopped = false;
  let failure: Error | null = null;
  const loop = (async () => {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
      if (stopped) break;
      try {
        const next = await read();
        samples.push(cpuSampleBetween(last, next, periodUsec));
        last = next;
      } catch (e) {
        failure = e as Error;
        return;
      }
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await loop;
      if (failure) throw failure;
      return summariseCpu(container, share, intervalSeconds, samples);
    },
  };
}

/**
 * The plugin host's failure lines: a failed load / operation / render
 * (`recordPluginError`, plugin-host/runtime-health.ts) and a change
 * consumer that stopped (plugin-host/change-consumers.ts).
 */
const PLUGIN_FAILED = /\[plugin-host\] ([a-z0-9][a-z0-9-]*) [a-z_-]+ failed \(/;
const CONSUMER_STOPPED = /\[plugin-host\] change consumer of "([a-z0-9][a-z0-9-]*)" stopped/;
/** Host-level failures no single plugin is named in. */
const HOST_FAILED =
  /\[plugin-host\] (?:draining the change consumers failed|the change-journal LISTEN connection dropped|plugin runtime heartbeat failed)/;

/** Plugin failures in a stretch of the admin log, per plugin slug (`(host)` = not one plugin's). */
export function countPluginFailures(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const slug =
      CONSUMER_STOPPED.exec(line)?.[1] ??
      PLUGIN_FAILED.exec(line)?.[1] ??
      (HOST_FAILED.test(line) ? "(host)" : null);
    if (slug) out[slug] = (out[slug] ?? 0) + 1;
  }
  return out;
}

/** A first sample of each plugin failure, for diagnosis. */
export function samplePluginFailures(text: string, max: number): string[] {
  const seen = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!(CONSUMER_STOPPED.test(line) || PLUGIN_FAILED.test(line) || HOST_FAILED.test(line))) {
      continue;
    }
    const key = line.replace(/[0-9a-f-]{36}/g, "<id>").slice(0, 160);
    if (!seen.has(key)) seen.set(key, line.slice(0, 400));
    if (seen.size >= max) break;
  }
  return [...seen.values()];
}

/** One scheduler task run as the tick endpoint answers it. */
export interface TickTaskRun {
  readonly key: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly detail: string | null;
}

/** The plugin workers' side of the ticks a run made. */
export interface TickSummary {
  readonly ticks: number;
  readonly tickErrors: number;
  /** Per worker (`<slug>/<worker>`): runs, failed runs, slowest run. */
  readonly workers: Record<string, { runs: number; failed: number; maxMs: number }>;
  /** Core tasks that did not finish ok (informational: dev-environment tasks may fail). */
  readonly coreFailures: readonly string[];
}

/** Fold one tick's task runs into the summary. */
export function addTick(
  summary: {
    ticks: number;
    tickErrors: number;
    workers: TickSummary["workers"];
    coreFailures: string[];
  },
  ran: readonly TickTaskRun[],
): void {
  summary.ticks += 1;
  for (const r of ran) {
    if (r.key.startsWith("plugin:")) {
      const name = r.key.slice("plugin:".length);
      const w = summary.workers[name] ?? { runs: 0, failed: 0, maxMs: 0 };
      w.runs += 1;
      if (r.outcome !== "ok") w.failed += 1;
      w.maxMs = Math.max(w.maxMs, Math.round(r.durationMs));
      summary.workers[name] = w;
    } else if (r.outcome !== "ok" && summary.coreFailures.length < 12) {
      summary.coreFailures.push(`${r.key} ${r.outcome}: ${(r.detail ?? "").slice(0, 200)}`);
    }
  }
}
