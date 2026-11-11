// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1595 — an admin stall becomes ONE automatic bug report, with the
 * evidence to find its cause.
 *
 * Signals: every transaction that fails on database trouble (the adapter's
 * `onDatabaseTrouble`: statement timeout, lock timeout, a session ended for
 * idling in a transaction, no free connection within the deadline), every
 * MCP call the back-pressure gate refuses, and every build that fails on
 * something other than a refusal while an incident is open.
 *
 * One incident spans signals until {@link INCIDENT_QUIET_MS} pass without
 * one; the next signal opens a new incident. A burst produced ~40 failure
 * lines in five minutes on 2026-11-11 (#1594): one report per failure would
 * bury the one that matters, one per incident is the signal. Database
 * trouble and a failed build are reportable at once; MCP refusals alone only
 * once they have lasted {@link SUSTAINED_REFUSAL_MS}, because a short burst
 * of parallel agent calls is load the gate exists to absorb.
 *
 * The report is filed with a snapshot of the database's sessions
 * (`diagnostics.database_activity`: who waits on what, who blocks whom) and
 * rewritten as the incident grows: counts, failing holders, the pool at its
 * fullest, failed builds, and a second snapshot when the pool got fuller
 * than at the first. Writes run one at a time; a signal during a write marks
 * the report dirty and the write repeats once it finished. A failed write is
 * not retried until the next signal (no timer, CLAUDE.md §11.B Tier 5).
 *
 * The capture's own operations never count as signals: a report write that
 * itself waits out the pool deadline must not feed the incident it reports.
 */

import type { DatabaseTrouble, PoolPressure } from "@caelo-cms/query-api";
import type { PhaseTiming } from "@caelo-cms/shared";
import {
  type DatabaseActivity,
  type IncidentBuild,
  type IncidentFacts,
  renderIncidentEvidence,
  SIGNAL_LABELS,
} from "./evidence.js";

/** Quiet time after which the next signal opens a new incident. */
export const INCIDENT_QUIET_MS = 120_000;

/** How long MCP refusals alone must last before they are reported. */
export const SUSTAINED_REFUSAL_MS = 30_000;

/** Snapshots per incident: the first, plus one at the pool's fullest. */
const MAX_SNAPSHOTS = 2;

/** Failed builds kept per incident. */
const MAX_BUILDS = 3;

/** The operations the capture runs itself; their failures are not signals. */
export const INCIDENT_CAPTURE_OPERATIONS: ReadonlySet<string> = new Set([
  "diagnostics.database_activity",
  "ai_bug_reports.create",
  "ai_bug_reports.update_incident",
]);

/** What the capture is told. */
export type IncidentSignal =
  | { readonly kind: "database"; readonly trouble: DatabaseTrouble }
  | { readonly kind: "mcp_refused" }
  | {
      readonly kind: "build_failed";
      readonly build: {
        readonly kind: string;
        readonly runId: string;
        readonly totalMs: number;
        readonly message: string;
        readonly phases: readonly PhaseTiming[];
      };
    };

/** The report fields the capture writes. */
export interface IncidentReportDraft {
  readonly title: string;
  readonly whatHappened: string;
  readonly expected: string;
  readonly evidence: string;
  readonly severity: "blocking" | "degraded";
  readonly blockedTask: boolean;
}

/** What the capture needs from the running admin. */
export interface IncidentCaptureDeps {
  readonly now: () => number;
  /** The admin pool's demand right now. */
  readonly pressure: () => PoolPressure;
  readonly snapshot: () => Promise<DatabaseActivity>;
  /** File the report; returns its id. */
  readonly file: (draft: IncidentReportDraft) => Promise<string>;
  readonly update: (reportId: string, draft: IncidentReportDraft) => Promise<void>;
  /**
   * Start `work` outside any transaction the signalling call chain holds
   * (the adapter's `deferUntilHeldTransactionEnds`): a public-pool failure
   * inside an admin transaction must not make the capture check out a
   * second admin connection on that chain.
   */
  readonly detach: (work: () => void) => void;
  readonly instance: string;
  readonly version: string;
}

interface Holding {
  count: number;
  readonly kinds: Set<string>;
  longestMs: number;
}

interface Incident {
  readonly openedAt: number;
  lastSignalAt: number;
  readonly firstSign: string;
  readonly counts: Map<string, number>;
  readonly holders: Map<string, Holding>;
  peak: PoolPressure | null;
  readonly builds: IncidentBuild[];
  readonly snapshots: { pressure: PoolPressure; activity: DatabaseActivity }[];
  snapshotError: string | null;
  /** Database trouble or a failed build: reportable without waiting. */
  hard: boolean;
  reportId: string | null;
  writing: boolean;
  dirty: boolean;
}

/** Whether `a` is a fuller pool than `b`: more waiting callers, then more in use. */
function fuller(a: PoolPressure, b: PoolPressure | null): boolean {
  if (b === null) return true;
  if (a.waiting !== b.waiting) return a.waiting > b.waiting;
  if (a.inUse !== b.inUse) return a.inUse > b.inUse;
  return a.oldestWaitMs > b.oldestWaitMs;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One process's incident state (see the file header). */
export class IncidentCapture {
  readonly #deps: IncidentCaptureDeps;
  #incident: Incident | null = null;

  constructor(deps: IncidentCaptureDeps) {
    this.#deps = deps;
  }

  /** Take one signal. Never throws, never waits: any database work is detached. */
  note(signal: IncidentSignal): void {
    try {
      this.#note(signal);
    } catch (e) {
      console.error("[incident] could not record a signal", message(e));
    }
  }

  #note(signal: IncidentSignal): void {
    if (signal.kind === "database" && INCIDENT_CAPTURE_OPERATIONS.has(signal.trouble.holder)) {
      return;
    }
    const now = this.#deps.now();
    let incident = this.#incident;
    if (incident === null || now - incident.lastSignalAt > INCIDENT_QUIET_MS) {
      // A failed build alone is not an incident: it has its own surface
      // (the run's error); it is evidence only while the database is in
      // trouble.
      if (signal.kind === "build_failed") return;
      incident = this.#open(signal, now);
    }
    incident.lastSignalAt = now;
    const label = signal.kind === "database" ? signal.trouble.kind : signal.kind;
    incident.counts.set(label, (incident.counts.get(label) ?? 0) + 1);
    if (signal.kind === "database") {
      const t = signal.trouble;
      const h = incident.holders.get(t.holder) ?? { count: 0, kinds: new Set(), longestMs: 0 };
      h.count += 1;
      h.kinds.add(t.kind);
      h.longestMs = Math.max(h.longestMs, t.elapsedMs);
      incident.holders.set(t.holder, h);
      incident.hard = true;
    } else if (signal.kind === "build_failed") {
      if (incident.builds.length < MAX_BUILDS) incident.builds.push({ ...signal.build });
      incident.hard = true;
    }
    const pressure = this.#deps.pressure();
    if (fuller(pressure, incident.peak)) incident.peak = pressure;
    if (incident.hard || now - incident.openedAt >= SUSTAINED_REFUSAL_MS) this.#write(incident);
  }

  #open(signal: IncidentSignal, now: number): Incident {
    const incident: Incident = {
      openedAt: now,
      lastSignalAt: now,
      firstSign: signal.kind === "database" ? signal.trouble.kind : signal.kind,
      counts: new Map(),
      holders: new Map(),
      peak: null,
      builds: [],
      snapshots: [],
      snapshotError: null,
      hard: false,
      reportId: null,
      writing: false,
      dirty: false,
    };
    this.#incident = incident;
    return incident;
  }

  /** Mark `incident`'s report for writing; start the write unless one runs. */
  #write(incident: Incident): void {
    incident.dirty = true;
    if (incident.writing) return;
    incident.writing = true;
    this.#deps.detach(() => {
      void this.#flush(incident);
    });
  }

  async #flush(incident: Incident): Promise<void> {
    try {
      while (incident.dirty) {
        incident.dirty = false;
        await this.#snapshotIfFuller(incident);
        const draft = this.#draft(incident);
        if (incident.reportId === null) {
          incident.reportId = await this.#deps.file(draft);
        } else {
          await this.#deps.update(incident.reportId, draft);
        }
      }
    } catch (e) {
      // The pool may still be full; the next signal tries again.
      console.error("[incident] could not write the incident report", message(e));
    } finally {
      incident.writing = false;
    }
  }

  /** Take a snapshot for the first report, and again once the pool got fuller than at the last one. */
  async #snapshotIfFuller(incident: Incident): Promise<void> {
    const last = incident.snapshots[incident.snapshots.length - 1];
    if (incident.snapshots.length >= MAX_SNAPSHOTS) return;
    const pressure = this.#deps.pressure();
    if (last !== undefined && !fuller(pressure, last.pressure)) return;
    try {
      const activity = await this.#deps.snapshot();
      incident.snapshots.push({ pressure, activity });
      incident.snapshotError = null;
    } catch (e) {
      incident.snapshotError = `the snapshot failed: ${message(e)}`;
    }
  }

  #draft(incident: Incident): IncidentReportDraft {
    const facts: IncidentFacts = {
      instance: this.#deps.instance,
      version: this.#deps.version,
      openedAt: incident.openedAt,
      lastSignalAt: incident.lastSignalAt,
      firstSign: incident.firstSign,
      counts: incident.counts,
      failingHolders: [...incident.holders]
        .map(([holder, h]) => ({
          holder,
          count: h.count,
          kinds: [...h.kinds],
          longestMs: h.longestMs,
        }))
        .sort((a, b) => b.count - a.count || b.longestMs - a.longestMs),
      peak: incident.peak,
      builds: incident.builds,
      snapshots: incident.snapshots,
      snapshotError: incident.snapshotError,
    };
    const blocked = incident.builds.length > 0;
    return {
      title: "Admin stalled: database calls timed out",
      // Stable per kind of first sign, so the bug intake's fingerprint
      // merges the same stall across incidents and installs; the numbers
      // live in the evidence.
      whatHappened: `The admin stalled on its database. First sign: ${SIGNAL_LABELS[incident.firstSign] ?? incident.firstSign}. Requests, background work and builds failed or waited while it lasted; the evidence names what held the connections and what the database sessions waited on.`,
      expected:
        "Database calls finish well inside the statement, lock and connection timeouts; a busy admin answers MCP calls instead of refusing them for longer than a burst.",
      evidence: renderIncidentEvidence(facts),
      severity: blocked ? "blocking" : "degraded",
      blockedTask: blocked,
    };
  }
}

let current: IncidentCapture | null = null;

/** Install the process's capture (the admin's hooks), or remove it (null, tests). */
export function setIncidentCapture(capture: IncidentCapture | null): void {
  current = capture;
}

/**
 * Hand a signal to the process's capture, if one is installed. For the
 * places that see a signal but not the capture: the MCP gate, the build
 * runner.
 */
export function noteIncidentSignal(signal: IncidentSignal): void {
  current?.note(signal);
}
