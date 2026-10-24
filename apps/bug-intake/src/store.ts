// SPDX-License-Identifier: MPL-2.0

/**
 * The intake's storage: pinned install keys, clusters (one per defect, one
 * public issue each), the fingerprint/issue indexes into them, and the raw
 * reports.
 *
 * Production keeps it in Firestore (firestore-store.ts), so the GitHub App
 * needs no repository write access at all: its only power is filing issues.
 * Every write is optimistic: `put` with the version read, `conflict` →
 * re-read and retry; first-writer-wins links answer `taken` / `conflict`.
 */

import type { BugClusterStatus, BugIntakeReport } from "@caelo-cms/shared";

/** One defect, as many installs reported it. */
export interface ClusterRecord {
  id: string;
  createdAt: string;
  source: "ai" | "auto";
  suspectedTool: string | null;
  /** Redacted text of the first report; the public issue is built from it. */
  title: string;
  whatHappened: string;
  expected: string;
  severity: "blocking" | "degraded" | "cosmetic";
  blockedTask: boolean;
  fingerprints: string[];
  /** SHA-256 of each reporting install id (the intake never lists raw ids). */
  installHashes: string[];
  occurrences: number;
  versions: string[];
  firstSeen: string;
  lastSeen: string;
  issueNumber: number | null;
  issueUrl: string | null;
  status: BugClusterStatus;
  fixedInVersion: string | null;
  /** Set when a maintainer closed this cluster's issue as a duplicate of another cluster's. */
  mergedInto: string | null;
  lastIssueSyncAt: string | null;
  /** Install counts already announced in a milestone comment. */
  milestonesCommented: number[];
}

/**
 * What the semantic matcher sees about a candidate cluster. The tool and
 * source are hints for the model, never a partition: the AI words one tool
 * differently from one chat to the next (#1049).
 */
export interface ClusterSummary {
  id: string;
  title: string;
  /** Cut to `CANDIDATE_TEXT_CHARS`, so the matcher prompt stays bounded. */
  whatHappened: string;
  suspectedTool: string | null;
  source: "ai" | "auto";
}

export interface StoredReport {
  reportId: string;
  installHash: string;
  receivedAt: string;
  clusterId: string;
  /** Redacted as sent; `evidence` never leaves this store. */
  report: BugIntakeReport;
}

export interface Versioned<T> {
  value: T;
  version: string;
}

export interface IntakeStore {
  getInstallKey(installId: string): Promise<string | null>;
  /** Pin a key for an install id; `conflict` if a different key is already pinned. */
  pinInstallKey(installId: string, publicKey: string): Promise<"pinned" | "same" | "conflict">;
  getReport(reportId: string): Promise<StoredReport | null>;
  /** First write wins: a retried report id writes nothing new. */
  putReport(report: StoredReport): Promise<void>;
  clusterIdForFingerprint(fingerprint: string): Promise<string | null>;
  /** `taken` = another cluster claimed this fingerprint first; use that one. */
  linkFingerprint(fingerprint: string, clusterId: string): Promise<"linked" | "taken">;
  clusterIdForIssue(issueNumber: number): Promise<string | null>;
  linkIssue(issueNumber: number, clusterId: string): Promise<void>;
  getCluster(id: string): Promise<Versioned<ClusterRecord> | null>;
  /** Create (version null) or replace the version read. */
  putCluster(cluster: ClusterRecord, version: string | null): Promise<"ok" | "conflict">;
  /**
   * The matcher's candidate pool: at most `MAX_CANDIDATES` clusters of any
   * tool and source, newest first. A store that has never held a pool builds
   * it from its clusters on first use (#1049).
   */
  candidates(): Promise<ClusterSummary[]>;
  /** Put a cluster at the front of the pool (once), dropping the oldest beyond the cap. */
  addCandidate(summary: ClusterSummary): Promise<void>;
  /**
   * Take one of `limit` new-issue slots for a UTC day (`YYYY-MM-DD`); false
   * when the day's slots are used up. Atomic: concurrent takers never exceed
   * the limit together.
   */
  takeIssueSlot(day: string, limit: number): Promise<boolean>;
  /** Give back a slot whose issue was not created after all (GitHub refused). */
  returnIssueSlot(day: string): Promise<void>;
  /**
   * Queue a cluster that is due an issue but could not get one yet (daily cap,
   * kill switch, GitHub failure). Re-marking keeps the original `since`, so
   * the queue stays first-come, first-filed.
   */
  markIssuePending(clusterId: string, since: string): Promise<void>;
  clearIssuePending(clusterId: string): Promise<void>;
  /** Oldest queued cluster ids first. */
  pendingIssueClusters(limit: number): Promise<string[]>;
}

/**
 * Size of the candidate pool. Every candidate goes into one matcher prompt,
 * so this and `CANDIDATE_TEXT_CHARS` bound the prompt (about 40 x 1 kB);
 * the pool keeps the newest clusters because older defects rarely recur in
 * new wording.
 */
export const MAX_CANDIDATES = 40;

/** `whatHappened` characters a candidate carries into the matcher prompt. */
export const CANDIDATE_TEXT_CHARS = 600;

/** The pool entry for a cluster. */
export function clusterSummary(c: ClusterRecord): ClusterSummary {
  return {
    id: c.id,
    title: c.title,
    whatHappened: c.whatHappened.slice(0, CANDIDATE_TEXT_CHARS),
    suspectedTool: c.suspectedTool,
    source: c.source,
  };
}

/**
 * The pool a store builds when it has none yet (the first run after #1049
 * replaced the per-tool lists): the most recently reported clusters, AI and
 * auto alike. Merged clusters are left out; their reports belong to the
 * cluster they were merged into, which is a candidate of its own.
 */
export function poolFromClusters(clusters: ClusterRecord[]): ClusterSummary[] {
  return clusters
    .filter((c) => c.mergedInto === null)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.id.localeCompare(b.id))
    .slice(0, MAX_CANDIDATES)
    .map(clusterSummary);
}

/** `summary` at the front of `pool`, without its older entry, capped at `MAX_CANDIDATES`. */
export function withCandidate(pool: ClusterSummary[], summary: ClusterSummary): ClusterSummary[] {
  return [summary, ...pool.filter((x) => x.id !== summary.id)].slice(0, MAX_CANDIDATES);
}

/** In-memory store for tests and local runs. */
export class MemoryStore implements IntakeStore {
  keys = new Map<string, string>();
  reports = new Map<string, StoredReport>();
  fingerprints = new Map<string, string>();
  issues = new Map<number, string>();
  clusters = new Map<string, Versioned<ClusterRecord>>();
  /** null until first use, like a database that predates the pool. */
  pool: ClusterSummary[] | null = null;
  issueSlots = new Map<string, number>();
  pending = new Map<string, string>();
  #v = 0;

  async getInstallKey(id: string) {
    return this.keys.get(id) ?? null;
  }
  async pinInstallKey(id: string, key: string) {
    const cur = this.keys.get(id);
    if (cur === undefined) {
      this.keys.set(id, key);
      return "pinned" as const;
    }
    return cur === key ? ("same" as const) : ("conflict" as const);
  }
  async getReport(id: string) {
    return this.reports.get(id) ?? null;
  }
  async putReport(r: StoredReport) {
    if (!this.reports.has(r.reportId)) this.reports.set(r.reportId, structuredClone(r));
  }
  async clusterIdForFingerprint(fp: string) {
    return this.fingerprints.get(fp) ?? null;
  }
  async linkFingerprint(fp: string, id: string) {
    if (this.fingerprints.has(fp)) return "taken" as const;
    this.fingerprints.set(fp, id);
    return "linked" as const;
  }
  async clusterIdForIssue(n: number) {
    return this.issues.get(n) ?? null;
  }
  async linkIssue(n: number, id: string) {
    this.issues.set(n, id);
  }
  async getCluster(id: string) {
    const c = this.clusters.get(id);
    return c ? structuredClone(c) : null;
  }
  async putCluster(c: ClusterRecord, version: string | null) {
    const cur = this.clusters.get(c.id);
    if ((cur?.version ?? null) !== version) return "conflict" as const;
    this.clusters.set(c.id, { value: structuredClone(c), version: String(++this.#v) });
    return "ok" as const;
  }
  #ensurePool(): ClusterSummary[] {
    this.pool ??= poolFromClusters([...this.clusters.values()].map((c) => c.value));
    return this.pool;
  }
  async candidates() {
    return structuredClone(this.#ensurePool());
  }
  async addCandidate(s: ClusterSummary) {
    this.pool = withCandidate(this.#ensurePool(), structuredClone(s));
  }
  async takeIssueSlot(day: string, limit: number) {
    const used = this.issueSlots.get(day) ?? 0;
    if (used >= limit) return false;
    this.issueSlots.set(day, used + 1);
    return true;
  }
  async returnIssueSlot(day: string) {
    this.issueSlots.set(day, Math.max(0, (this.issueSlots.get(day) ?? 0) - 1));
  }
  async markIssuePending(id: string, since: string) {
    if (!this.pending.has(id)) this.pending.set(id, since);
  }
  async clearIssuePending(id: string) {
    this.pending.delete(id);
  }
  async pendingIssueClusters(limit: number) {
    return [...this.pending.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([id]) => id);
  }
}
