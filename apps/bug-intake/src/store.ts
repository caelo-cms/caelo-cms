// SPDX-License-Identifier: MPL-2.0

/**
 * The intake's storage: pinned install keys, clusters (one per defect, one
 * public issue each), the fingerprint/issue indexes into them, and the raw
 * reports.
 *
 * Production keeps it as JSON files in a PRIVATE GitHub repository (no
 * database to run; history for free; maintainers can read it). Every write
 * is optimistic: `put` with the version read, `conflict` → re-read and
 * retry. The interface is the seam to move to a database when the volume
 * outgrows the GitHub API budget (~5,000 calls an hour; a report costs ~5).
 */

import type { BugClusterStatus, BugIntakeReport } from "@caelo-cms/shared";
import type { GitHubClient } from "./github.js";

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

/** What the semantic matcher sees about a candidate cluster. */
export interface ClusterSummary {
  id: string;
  title: string;
  whatHappened: string;
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
  putReport(report: StoredReport): Promise<void>;
  clusterIdForFingerprint(fingerprint: string): Promise<string | null>;
  /** `taken` = another cluster claimed this fingerprint first; use that one. */
  linkFingerprint(fingerprint: string, clusterId: string): Promise<"linked" | "taken">;
  clusterIdForIssue(issueNumber: number): Promise<string | null>;
  linkIssue(issueNumber: number, clusterId: string): Promise<void>;
  getCluster(id: string): Promise<Versioned<ClusterRecord> | null>;
  /** Create (version null) or replace the version read. */
  putCluster(cluster: ClusterRecord, version: string | null): Promise<"ok" | "conflict">;
  /** Recent AI-filed clusters for one suspected tool: the matcher's candidates. */
  candidates(toolKey: string): Promise<ClusterSummary[]>;
  addCandidate(toolKey: string, summary: ClusterSummary): Promise<void>;
}

/** Candidate lists keep the newest entries only; older defects rarely recur in new wording. */
export const MAX_CANDIDATES_PER_TOOL = 30;

/** Index key for a suspected tool (`_none` when the report named none). */
export function toolKey(suspectedTool: string | null): string {
  const k = (suspectedTool ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "_");
  return k === "" ? "_none" : k.slice(0, 80);
}

/** In-memory store for tests and local runs. */
export class MemoryStore implements IntakeStore {
  keys = new Map<string, string>();
  reports = new Map<string, StoredReport>();
  fingerprints = new Map<string, string>();
  issues = new Map<number, string>();
  clusters = new Map<string, Versioned<ClusterRecord>>();
  tools = new Map<string, ClusterSummary[]>();
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
    this.reports.set(r.reportId, structuredClone(r));
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
  async candidates(key: string) {
    return this.tools.get(key) ?? [];
  }
  async addCandidate(key: string, s: ClusterSummary) {
    this.tools.set(key, [s, ...(this.tools.get(key) ?? [])].slice(0, MAX_CANDIDATES_PER_TOOL));
  }
}

/**
 * Production store: JSON files in the private data repository.
 *
 *   installs/<installId>.json        { publicKey }
 *   reports/<id[0..2]>/<id>.json     StoredReport
 *   fingerprints/<fp>.json           { clusterId }
 *   issues/<number>.json             { clusterId }
 *   clusters/<clusterId>.json        ClusterRecord
 *   candidates/<toolKey>.json        ClusterSummary[]
 */
export class GitHubRepoStore implements IntakeStore {
  constructor(
    readonly gh: GitHubClient,
    readonly repo: string,
  ) {}

  async getInstallKey(id: string) {
    return (
      (await this.gh.getJson<{ publicKey: string }>(this.repo, `installs/${id}.json`))?.value
        .publicKey ?? null
    );
  }

  async pinInstallKey(id: string, publicKey: string) {
    const cur = await this.getInstallKey(id);
    if (cur !== null) return cur === publicKey ? ("same" as const) : ("conflict" as const);
    const r = await this.gh.putJson(
      this.repo,
      `installs/${id}.json`,
      { publicKey },
      null,
      `pin install ${id}`,
    );
    if (r === "ok") return "pinned" as const;
    // Lost a race with a concurrent registration of the same id.
    return (await this.getInstallKey(id)) === publicKey ? ("same" as const) : ("conflict" as const);
  }

  #reportPath(id: string) {
    return `reports/${id.slice(0, 2)}/${id}.json`;
  }

  async getReport(id: string) {
    return (await this.gh.getJson<StoredReport>(this.repo, this.#reportPath(id)))?.value ?? null;
  }

  async putReport(r: StoredReport) {
    // Report ids are unique per install; a retry of the same report writes nothing new.
    await this.gh.putJson(this.repo, this.#reportPath(r.reportId), r, null, `report ${r.reportId}`);
  }

  async clusterIdForFingerprint(fp: string) {
    return (
      (await this.gh.getJson<{ clusterId: string }>(this.repo, `fingerprints/${fp}.json`))?.value
        .clusterId ?? null
    );
  }

  async linkFingerprint(fp: string, clusterId: string) {
    const r = await this.gh.putJson(
      this.repo,
      `fingerprints/${fp}.json`,
      { clusterId },
      null,
      `fingerprint ${fp.slice(0, 12)} → ${clusterId}`,
    );
    return r === "ok" ? ("linked" as const) : ("taken" as const);
  }

  async clusterIdForIssue(n: number) {
    return (
      (await this.gh.getJson<{ clusterId: string }>(this.repo, `issues/${n}.json`))?.value
        .clusterId ?? null
    );
  }

  async linkIssue(n: number, clusterId: string) {
    const cur = await this.gh.getJson<{ clusterId: string }>(this.repo, `issues/${n}.json`);
    await this.gh.putJson(
      this.repo,
      `issues/${n}.json`,
      { clusterId },
      cur?.sha ?? null,
      `issue #${n}`,
    );
  }

  async getCluster(id: string) {
    const r = await this.gh.getJson<ClusterRecord>(this.repo, `clusters/${id}.json`);
    return r ? { value: r.value, version: r.sha } : null;
  }

  async putCluster(c: ClusterRecord, version: string | null) {
    return this.gh.putJson(this.repo, `clusters/${c.id}.json`, c, version, `cluster ${c.id}`);
  }

  async candidates(key: string) {
    return (
      (await this.gh.getJson<ClusterSummary[]>(this.repo, `candidates/${key}.json`))?.value ?? []
    );
  }

  async addCandidate(key: string, s: ClusterSummary) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await this.gh.getJson<ClusterSummary[]>(this.repo, `candidates/${key}.json`);
      const next = [s, ...(cur?.value ?? []).filter((x) => x.id !== s.id)].slice(
        0,
        MAX_CANDIDATES_PER_TOOL,
      );
      const r = await this.gh.putJson(
        this.repo,
        `candidates/${key}.json`,
        next,
        cur?.sha ?? null,
        `candidates ${key}`,
      );
      if (r === "ok") return;
    }
    throw new Error(`candidates/${key}.json: five write conflicts in a row`);
  }
}
