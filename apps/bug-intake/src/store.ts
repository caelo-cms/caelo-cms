// SPDX-License-Identifier: MPL-2.0

/**
 * The intake's storage: pinned install keys, clusters (one per defect or
 * suggestion, one public issue each), the fingerprint/issue indexes into
 * them, and the raw reports.
 *
 * Production keeps it in Firestore (firestore-store.ts), so the GitHub App
 * needs no repository write access at all: its only power is filing issues.
 * Every write is optimistic: `put` with the version read, `conflict` →
 * re-read and retry; first-writer-wins links answer `taken` / `conflict`.
 *
 * Kinds (#1192): defects and suggestions never share anything that decides
 * where a report goes or whether it gets an issue. The fingerprint index,
 * the matcher's candidate pool, the daily issue slots and the pending queue
 * all exist once per kind, so a suggestion can neither join a defect's
 * cluster nor take a defect's slot, and the other way round.
 */

import {
  BUG_REPORT_KIND_BEFORE_1192,
  type BugClusterStatus,
  type BugIntakeReport,
  type BugReportKind,
  type BugReportSeverity,
} from "@caelo-cms/shared";

/** One defect or suggestion, as many installs reported it. */
export interface ClusterRecord {
  id: string;
  createdAt: string;
  kind: BugReportKind;
  source: "ai" | "auto";
  suspectedTool: string | null;
  /** Redacted text of the first report; the public issue is built from it. */
  title: string;
  whatHappened: string;
  expected: string;
  /** The worst severity reported; null for a suggestion, which has none. */
  severity: BugReportSeverity | null;
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
 * differently from one chat to the next (#1049). The kind IS a partition
 * (#1192): it picks the pool the summary lives in.
 */
export interface ClusterSummary {
  id: string;
  kind: BugReportKind;
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
  /** The cluster of this kind that claimed `fingerprint`; the other kind's index is never read. */
  clusterIdForFingerprint(kind: BugReportKind, fingerprint: string): Promise<string | null>;
  /** `taken` = another cluster of this kind claimed this fingerprint first; use that one. */
  linkFingerprint(
    kind: BugReportKind,
    fingerprint: string,
    clusterId: string,
  ): Promise<"linked" | "taken">;
  clusterIdForIssue(issueNumber: number): Promise<string | null>;
  linkIssue(issueNumber: number, clusterId: string): Promise<void>;
  getCluster(id: string): Promise<Versioned<ClusterRecord> | null>;
  /** Create (version null) or replace the version read. */
  putCluster(cluster: ClusterRecord, version: string | null): Promise<"ok" | "conflict">;
  /**
   * The matcher's candidate pool of one kind: at most `MAX_CANDIDATES`
   * clusters of that kind, any tool and source, newest first. A store that
   * has never held the pool builds it from its clusters on first use (#1049).
   */
  candidates(kind: BugReportKind): Promise<ClusterSummary[]>;
  /** Put a cluster at the front of its kind's pool (once), dropping the oldest beyond the cap. */
  addCandidate(summary: ClusterSummary): Promise<void>;
  /**
   * Take one of `limit` new-issue slots of a kind for a UTC day
   * (`YYYY-MM-DD`); false when the day's slots are used up. Atomic:
   * concurrent takers never exceed the limit together.
   */
  takeIssueSlot(kind: BugReportKind, day: string, limit: number): Promise<boolean>;
  /** Give back a slot whose issue was not created after all (GitHub refused). */
  returnIssueSlot(kind: BugReportKind, day: string): Promise<void>;
  /**
   * Queue a cluster that is due an issue but could not get one yet (daily cap,
   * kill switch, GitHub failure). Re-marking keeps the original `since`, so
   * the queue stays first-come, first-filed.
   */
  markIssuePending(kind: BugReportKind, clusterId: string, since: string): Promise<void>;
  clearIssuePending(kind: BugReportKind, clusterId: string): Promise<void>;
  /** Oldest queued cluster ids of a kind first. */
  pendingIssueClusters(kind: BugReportKind, limit: number): Promise<string[]>;
}

/** Every kind, in the order the intake drains their queues. */
export const REPORT_KINDS: readonly BugReportKind[] = ["defect", "suggestion"];

/**
 * The kind of a record read back from the store. Clusters and pool entries
 * written before #1192 carry none, and every one of them is a defect: the
 * same contract rule as a report without `kind` ({@link BUG_REPORT_KIND_BEFORE_1192}).
 * Anything else stored there is corrupt and fails loudly.
 */
export function storedKind(kind: unknown): BugReportKind {
  if (kind === undefined) return BUG_REPORT_KIND_BEFORE_1192;
  if (kind === "defect" || kind === "suggestion") return kind;
  throw new Error(`stored bug-intake record has an unknown kind ${JSON.stringify(kind)}`);
}

/**
 * Size of each candidate pool. Every candidate goes into one matcher prompt,
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
    kind: c.kind,
    title: c.title,
    whatHappened: c.whatHappened.slice(0, CANDIDATE_TEXT_CHARS),
    suspectedTool: c.suspectedTool,
    source: c.source,
  };
}

/**
 * The pool of `kind` a store builds when it has none yet (the first run
 * after #1049 replaced the per-tool lists, or after #1192 added the
 * suggestion pool): the most recently reported clusters of that kind, AI
 * and auto alike. Merged clusters are left out; their reports belong to the
 * cluster they were merged into, which is a candidate of its own.
 */
export function poolFromClusters(clusters: ClusterRecord[], kind: BugReportKind): ClusterSummary[] {
  return clusters
    .filter((c) => c.mergedInto === null && c.kind === kind)
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
  /** Keyed `<kind>:<fingerprint>`, one index per kind. */
  fingerprints = new Map<string, string>();
  issues = new Map<number, string>();
  clusters = new Map<string, Versioned<ClusterRecord>>();
  /** null until first use, like a database that predates the pool. */
  pools: Record<BugReportKind, ClusterSummary[] | null> = { defect: null, suggestion: null };
  /** Keyed `<kind>:<day>`. */
  issueSlots = new Map<string, number>();
  pending: Record<BugReportKind, Map<string, string>> = {
    defect: new Map(),
    suggestion: new Map(),
  };
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
  async clusterIdForFingerprint(kind: BugReportKind, fp: string) {
    return this.fingerprints.get(`${kind}:${fp}`) ?? null;
  }
  async linkFingerprint(kind: BugReportKind, fp: string, id: string) {
    const key = `${kind}:${fp}`;
    if (this.fingerprints.has(key)) return "taken" as const;
    this.fingerprints.set(key, id);
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
  #ensurePool(kind: BugReportKind): ClusterSummary[] {
    const built =
      this.pools[kind] ??
      poolFromClusters(
        [...this.clusters.values()].map((c) => c.value),
        kind,
      );
    this.pools[kind] = built;
    return built;
  }
  async candidates(kind: BugReportKind) {
    return structuredClone(this.#ensurePool(kind));
  }
  async addCandidate(s: ClusterSummary) {
    this.pools[s.kind] = withCandidate(this.#ensurePool(s.kind), structuredClone(s));
  }
  async takeIssueSlot(kind: BugReportKind, day: string, limit: number) {
    const key = `${kind}:${day}`;
    const used = this.issueSlots.get(key) ?? 0;
    if (used >= limit) return false;
    this.issueSlots.set(key, used + 1);
    return true;
  }
  async returnIssueSlot(kind: BugReportKind, day: string) {
    const key = `${kind}:${day}`;
    this.issueSlots.set(key, Math.max(0, (this.issueSlots.get(key) ?? 0) - 1));
  }
  async markIssuePending(kind: BugReportKind, id: string, since: string) {
    if (!this.pending[kind].has(id)) this.pending[kind].set(id, since);
  }
  async clearIssuePending(kind: BugReportKind, id: string) {
    this.pending[kind].delete(id);
  }
  async pendingIssueClusters(kind: BugReportKind, limit: number) {
    return [...this.pending[kind].entries()]
      .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([id]) => id);
  }
}
