// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1595 — the text of an incident's bug report: what failed, what held
 * the pool, and from the database's own session list who waited on whom.
 *
 * The 2026-11-11 searchVIU stall (#1594) is the reference. Its logs showed
 * which ops held the ten connections, but not what each one waited on, so
 * whether it was a lock queue, an idle transaction or a CPU-starved database
 * had to be pieced together from three sources afterwards. This report puts
 * the answer in one place and states it as a sentence ({@link diagnose}):
 * sessions blocked by another session are a lock queue (and the blocker is
 * named), sessions idle inside an open transaction hold their locks while
 * waiting on something outside the database, and statements that run
 * without waiting on anything are on the CPU.
 *
 * Pure module: the capture (capture.ts) collects, this renders. Nothing here
 * reads a parameter or a content value; statement text arrives already
 * stripped of literals (`sanitizeStatement`), and the bug forwarder redacts
 * the text once more before anything leaves the install.
 */

import type { PoolPressure } from "@caelo-cms/query-api";
import type { PhaseTiming } from "@caelo-cms/shared";

/** One database session at snapshot time (diagnostics.database_activity). */
export interface ActivitySession {
  readonly pid: number;
  readonly database: string | null;
  readonly role: string | null;
  /** `active`, `idle in transaction`, `idle`, … */
  readonly state: string | null;
  readonly waitEventType: string | null;
  readonly waitEvent: string | null;
  /** How long its transaction is open; null outside a transaction. */
  readonly xactMs: number | null;
  /** How long its current (or last) statement has run. */
  readonly queryMs: number | null;
  /** How long it is in its current state. */
  readonly stateMs: number | null;
  /** The sessions it waits for (`pg_blocking_pids`). */
  readonly blockedBy: readonly number[];
  /** Its statement without literals, or null where the role may not read it. */
  readonly statement: string | null;
}

/** The database's view at one moment. */
export interface DatabaseActivity {
  readonly takenAt: string;
  readonly sessions: readonly ActivitySession[];
  /** Deadlocks Postgres resolved in cms_admin since its statistics reset. */
  readonly deadlocks: number;
}

/** A build that failed while the incident was open. */
export interface IncidentBuild {
  readonly kind: string;
  readonly runId: string;
  readonly totalMs: number;
  readonly message: string;
  readonly phases: readonly PhaseTiming[];
}

/** A transaction holder that failed during the incident. */
export interface FailingHolder {
  readonly holder: string;
  readonly count: number;
  readonly kinds: readonly string[];
  readonly longestMs: number;
}

/** Everything an incident collected, as the renderer needs it. */
export interface IncidentFacts {
  readonly instance: string;
  readonly version: string;
  readonly openedAt: number;
  readonly lastSignalAt: number;
  readonly firstSign: string;
  /** Signal label → how often it was seen. */
  readonly counts: ReadonlyMap<string, number>;
  readonly failingHolders: readonly FailingHolder[];
  /** The admin pool at its fullest during the incident. */
  readonly peak: PoolPressure | null;
  readonly builds: readonly IncidentBuild[];
  readonly snapshots: readonly {
    readonly pressure: PoolPressure;
    readonly activity: DatabaseActivity;
  }[];
  /** Why a snapshot is missing, when it is. */
  readonly snapshotError: string | null;
}

/** The evidence column's limit (ai_bug_reports.create). */
export const EVIDENCE_MAX_CHARS = 8000;

/** What a signal label reads as in the report. */
export const SIGNAL_LABELS: Readonly<Record<string, string>> = {
  pool_wait_timeout: "callers found no free database connection within the wait deadline",
  statement_timeout: "statements ran past the statement timeout",
  lock_timeout: "lock waits ran past the lock timeout",
  idle_in_transaction_timeout: "Postgres ended a session idle inside a transaction",
  mcp_refused: "MCP calls were refused with 429 (pool saturated)",
  build_failed: "a build failed",
};

const seconds = (ms: number | null): string =>
  ms === null ? "?" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * A statement as the report may show it: string literals replaced, white
 * space collapsed, cut to a line. Null for text the role may not read.
 */
export function sanitizeStatement(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "<insufficient privilege>") return null;
  return trimmed
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "'?'")
    .replace(/[Ee]?'(?:[^']|'')*'/g, "'?'")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

/** Sessions that are blocked by nobody but block someone: the start of a lock queue. */
function rootBlockers(sessions: readonly ActivitySession[]): ActivitySession[] {
  const byPid = new Map(sessions.map((s) => [s.pid, s]));
  const blockers = new Set(sessions.flatMap((s) => s.blockedBy));
  return [...blockers]
    .map((pid) => byPid.get(pid))
    .filter((s): s is ActivitySession => s !== undefined && s.blockedBy.length === 0);
}

const describeSession = (s: ActivitySession): string =>
  `pid ${s.pid} ${s.state ?? "?"}${s.waitEventType ? ` (waits ${s.waitEventType}/${s.waitEvent ?? "?"})` : ""}` +
  `, transaction open ${seconds(s.xactMs)}, statement ${seconds(s.queryMs)}` +
  `${s.database ? `, ${s.database}` : ""}${s.role ? `/${s.role}` : ""}: ${s.statement ?? "(statement not readable)"}`;

/**
 * What the session list says the database was doing, as sentences, most
 * telling first. Thresholds are deliberately low: a snapshot is a single
 * moment, so two sessions in the same state already are a pattern.
 */
export function diagnose(activity: DatabaseActivity): string[] {
  const out: string[] = [];
  const sessions = activity.sessions;
  const blocked = sessions.filter((s) => s.blockedBy.length > 0);
  if (blocked.length > 0) {
    const roots = rootBlockers(sessions);
    out.push(
      `Lock queue: ${blocked.length} session(s) wait for locks another session holds` +
        (roots.length > 0
          ? `; the queue starts at ${roots.map((r) => `pid ${r.pid} (${r.state ?? "?"}, transaction open ${seconds(r.xactMs)})`).join(", ")}.`
          : "."),
    );
  }
  const idleInTx = sessions.filter(
    (s) => s.state?.startsWith("idle in transaction") && (s.stateMs ?? 0) >= 5_000,
  );
  if (idleInTx.length > 0) {
    const longest = Math.max(...idleInTx.map((s) => s.stateMs ?? 0));
    out.push(
      `${idleInTx.length} transaction(s) sit idle while open (longest ${seconds(longest)}): their holder waits on something outside the database — another connection, a plugin, a build, a network call — while it keeps its locks and its connection.`,
    );
  }
  const onCpu = sessions.filter((s) => s.state === "active" && s.waitEventType === null);
  const slowOnCpu = onCpu.filter((s) => (s.queryMs ?? 0) >= 5_000);
  if (onCpu.length >= 2 && blocked.length === 0) {
    out.push(
      `${onCpu.length} statement(s) run without waiting on anything (on the CPU)${slowOnCpu.length > 0 ? `, ${slowOnCpu.length} of them for 5 s or more` : ""}: the database is CPU-bound. On a shared-core tier (db-f1-micro) that is its CPU ceiling; look at which reads run (statements below) and whether they read more than the request names.`,
    );
  }
  const io = sessions.filter((s) => s.state === "active" && s.waitEventType === "IO");
  if (io.length >= 2) {
    out.push(`${io.length} statement(s) wait on disk IO: the database is IO-bound.`);
  }
  if (out.length === 0) {
    out.push(
      "No session waits on a lock, sits idle in a transaction or runs on the CPU at snapshot time: the admin's own pool holders (above) held the connections — look at what they did between their statements.",
    );
  }
  return out;
}

function stateCounts(sessions: readonly ActivitySession[]): string {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const key =
      s.state === "active"
        ? `active ${s.waitEventType === null ? "on CPU" : `waiting ${s.waitEventType}`}`
        : (s.state ?? "unknown");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

function renderSnapshot(
  label: string,
  snap: { readonly pressure: PoolPressure; readonly activity: DatabaseActivity },
): string[] {
  const { pressure, activity } = snap;
  const lines = [
    `## Snapshot (${label}) at ${activity.takenAt}`,
    `Admin pool of this instance: ${pressure.inUse}/${pressure.max} in use, ${pressure.waiting} waiting (oldest ${seconds(pressure.oldestWaitMs)}).`,
    `Database sessions (every instance): ${activity.sessions.length} — ${stateCounts(activity.sessions)}. Deadlocks so far: ${activity.deadlocks}.`,
    "Diagnosis:",
    ...diagnose(activity).map((d) => `- ${d}`),
  ];
  const blocked = activity.sessions.filter((s) => s.blockedBy.length > 0);
  if (blocked.length > 0) {
    lines.push("Blocked sessions (→ the pids they wait for):");
    for (const s of blocked.slice(0, 8)) {
      lines.push(`- ${describeSession(s)} → ${s.blockedBy.join(", ")}`);
    }
    const roots = rootBlockers(activity.sessions);
    if (roots.length > 0) {
      lines.push("Where the lock queue starts:");
      for (const s of roots.slice(0, 4)) lines.push(`- ${describeSession(s)}`);
    }
  }
  const longest = activity.sessions
    .filter((s) => s.state !== "idle" && s.blockedBy.length === 0)
    .sort((a, b) => (b.xactMs ?? b.queryMs ?? 0) - (a.xactMs ?? a.queryMs ?? 0))
    .slice(0, 8);
  if (longest.length > 0) {
    lines.push("Longest open sessions (not blocked):");
    for (const s of longest) lines.push(`- ${describeSession(s)}`);
  }
  return lines;
}

/**
 * The report's evidence text, cut to {@link EVIDENCE_MAX_CHARS}. Sections
 * come in the order a reader needs them, so a cut loses the least useful
 * lines (the long session lists) first.
 */
export function renderIncidentEvidence(facts: IncidentFacts): string {
  const lines: string[] = [
    `Instance ${facts.instance}, Caelo ${facts.version}. Incident from ${iso(facts.openedAt)} to ${iso(facts.lastSignalAt)} (${seconds(facts.lastSignalAt - facts.openedAt)} so far). First sign: ${SIGNAL_LABELS[facts.firstSign] ?? facts.firstSign}.`,
    "## Signals",
    ...[...facts.counts].map(([k, n]) => `- ${n}× ${SIGNAL_LABELS[k] ?? k}`),
  ];
  if (facts.failingHolders.length > 0) {
    lines.push("## Failing transactions (holder: what it met)");
    for (const h of facts.failingHolders.slice(0, 12)) {
      lines.push(
        `- ${h.holder}: ${h.count}× ${h.kinds.join(", ")} (longest ${seconds(h.longestMs)})`,
      );
    }
  }
  if (facts.peak !== null) {
    lines.push(
      "## Admin pool at its fullest",
      `${facts.peak.inUse}/${facts.peak.max} in use, ${facts.peak.waiting} waiting (oldest ${seconds(facts.peak.oldestWaitMs)}). Holders, longest first:`,
      ...facts.peak.holders.slice(0, 10).map((h) => `- ${h.holder} ${seconds(h.heldMs)}`),
    );
  }
  for (const b of facts.builds) {
    const slowest = [...b.phases]
      .sort((x, y) => y.ms - x.ms)
      .slice(0, 5)
      .map((p) => `${p.phase} ${seconds(p.ms)}`)
      .join(", ");
    lines.push(
      `## ${b.kind} ${b.runId} failed after ${seconds(b.totalMs)}`,
      b.message.slice(0, 600),
      `Slowest phases: ${slowest || "none recorded"}.`,
    );
  }
  facts.snapshots.forEach((snap, i) => {
    lines.push(
      ...renderSnapshot(i === 0 ? "when the incident was reported" : "at the pool's fullest", snap),
    );
  });
  if (facts.snapshots.length === 0) {
    lines.push(`## No database snapshot: ${facts.snapshotError ?? "not taken yet"}`);
  }
  const text = lines.join("\n");
  return text.length <= EVIDENCE_MAX_CHARS
    ? text
    : `${text.slice(0, EVIDENCE_MAX_CHARS - 20)}\n… (cut)`;
}
