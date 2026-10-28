// SPDX-License-Identifier: MPL-2.0

/**
 * Production store of the bug intake (#980): one Firestore database that
 * belongs to the intake alone.
 *
 *   installs/<installId>                      { publicKey }
 *   reports/<reportId>                        StoredReport
 *   issues/<number>                           { clusterId }
 *   clusters/<clusterId>                      ClusterRecord
 *   defects:
 *     fingerprints/<fingerprint>              { clusterId }
 *     candidates/pool                         { items: ClusterSummary[] }
 *     issueSlots/<YYYY-MM-DD>                 { used }
 *     pendingIssues/<clusterId>               { since }
 *   suggestions (#1192):
 *     suggestionFingerprints/<fingerprint>    { clusterId }
 *     candidates/suggestion-pool              { items: ClusterSummary[] }
 *     suggestionIssueSlots/<YYYY-MM-DD>       { used }
 *     pendingSuggestionIssues/<clusterId>     { since }
 *
 * The defect names are the ones the database had before #1192, so the
 * live data carries over without a step. A collection per kind instead of a
 * `kind` field keeps every query a single-field one (no composite index to
 * deploy) and makes crossing kinds impossible rather than filtered out.
 * Clusters and pool entries written before #1192 have no `kind`; they read
 * back as defects (`storedKind`, the contract's rule for a missing kind).
 *
 * Moving here from a private GitHub repository is what lets the GitHub App
 * drop Contents: write. The concurrency contract of `IntakeStore` maps onto
 * Firestore primitives:
 *   - first-writer-wins links (`pinInstallKey`, `linkFingerprint`, a new
 *     cluster) use `create()`, which the server refuses with ALREADY_EXISTS;
 *   - a cluster's version is its document `updateTime`; `putCluster` writes
 *     with a `lastUpdateTime` precondition, which the server refuses with
 *     FAILED_PRECONDITION when anyone wrote since (or the document is gone);
 *   - read-modify-write lists and counters use the same compare-and-set
 *     (read, then create / precondition-update, re-read on refusal).
 *
 * Preconditions rather than transactions on purpose: server transactions
 * take pessimistic locks, so a contended writer waits for the lock instead
 * of losing fast, which is not the optimistic contract `IntakeStore`
 * promises (`conflict` → re-read and retry). A precondition write is one
 * RPC and never blocks.
 *
 * The candidate pool (#1049) replaced per-tool lists (`candidates/t_<tool>`),
 * which held AI clusters only. A database without a kind's pool document has
 * never had one: the first `candidates()` / `addCandidate()` deletes the old
 * per-tool documents, builds the pool from the clusters of that kind
 * (`poolFromClusters`) and creates it first-writer-wins. A build that stops
 * halfway runs again on the next request, because the pool document is
 * written last.
 *
 * Credentials: the client authenticates with Application Default
 * Credentials (the Cloud Run service account). There is no key-file path on
 * purpose. With `FIRESTORE_EMULATOR_HOST` set, the SDK talks to the emulator.
 */

import type { BugReportKind } from "@caelo-cms/shared";
import { type DocumentReference, Firestore, Timestamp } from "@google-cloud/firestore";
import {
  type ClusterRecord,
  type ClusterSummary,
  type IntakeStore,
  MAX_CANDIDATES,
  poolFromClusters,
  type StoredReport,
  storedKind,
  type Versioned,
  withCandidate,
} from "./store.js";

/** gRPC status the server answers `create()` with when the document exists. */
const ALREADY_EXISTS = 6;
/** gRPC status for a `lastUpdateTime` precondition that no longer holds. */
const FAILED_PRECONDITION = 9;
/** Compare-and-set attempts before a write gives up loudly. */
const MAX_CAS_ATTEMPTS = 10;

function grpcCode(e: unknown): unknown {
  return typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
}

function isAlreadyExists(e: unknown): boolean {
  return grpcCode(e) === ALREADY_EXISTS;
}

/** Document update time as an opaque, exactly comparable version string. */
function versionOf(t: Timestamp | undefined): string {
  if (!t) throw new Error("Firestore returned an existing document without an update time");
  return `${t.seconds}.${String(t.nanoseconds).padStart(9, "0")}`;
}

/** The update time a version string came from; null for a string this store never issued. */
function timestampOf(version: string): Timestamp | null {
  const m = /^(\d+)\.(\d{9})$/.exec(version);
  return m ? new Timestamp(Number(m[1]), Number(m[2])) : null;
}

/** Where each kind keeps the state that must never mix with the other kind's. */
const KIND_LAYOUT: Record<
  BugReportKind,
  { fingerprints: string; poolDoc: string; slots: string; pending: string }
> = {
  defect: {
    fingerprints: "fingerprints",
    poolDoc: "pool",
    slots: "issueSlots",
    pending: "pendingIssues",
  },
  suggestion: {
    fingerprints: "suggestionFingerprints",
    poolDoc: "suggestion-pool",
    slots: "suggestionIssueSlots",
    pending: "pendingSuggestionIssues",
  },
};

/** Prefix of the per-tool candidate documents the pool replaced. */
const LEGACY_CANDIDATE_PREFIX = "t_";
/** Clusters read per page while building the pool. */
const POOL_BUILD_PAGE = 100;

/** A cluster as stored; one written before #1192 gets its kind by the contract rule. */
function readCluster(data: Record<string, unknown>): ClusterRecord {
  return { ...(data as unknown as ClusterRecord), kind: storedKind(data.kind) };
}

/** A pool's entries as stored; entries written before #1192 are defects. */
function readPool(items: unknown): ClusterSummary[] {
  return (items as Array<ClusterSummary & { kind?: unknown }>).map((s) => ({
    ...s,
    kind: storedKind(s.kind),
  }));
}

export class FirestoreStore implements IntakeStore {
  constructor(readonly db: Firestore) {}

  /**
   * Client for one project + database, authenticated by the runtime service
   * account. `ignoreUndefinedProperties` gives JSON semantics (an undefined
   * optional field is simply absent), which is what the records are.
   */
  static connect(projectId: string, databaseId: string): FirestoreStore {
    return new FirestoreStore(
      new Firestore({ projectId, databaseId, ignoreUndefinedProperties: true }),
    );
  }

  #doc(collection: string, id: string) {
    return this.db.collection(collection).doc(id);
  }

  /**
   * Optimistic read-modify-write of one small document. `next` returns the
   * fields to write (`null` = leave it as it is) and the result to answer;
   * a concurrent writer makes the write fail fast and the loop re-reads.
   */
  async #compareAndSet<T extends Record<string, unknown>, R>(
    ref: DocumentReference,
    next: (current: T | undefined) => { write: T | null; result: R },
  ): Promise<R> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const snap = await ref.get();
      const { write, result } = next(snap.exists ? (snap.data() as T) : undefined);
      if (write === null) return result;
      try {
        if (snap.exists) await ref.update(write, { lastUpdateTime: snap.updateTime });
        else await ref.create(write);
        return result;
      } catch (e) {
        const code = grpcCode(e);
        if (code !== ALREADY_EXISTS && code !== FAILED_PRECONDITION) throw e;
      }
    }
    throw new Error(`${ref.path}: ${MAX_CAS_ATTEMPTS} write conflicts in a row`);
  }

  async getInstallKey(installId: string) {
    const snap = await this.#doc("installs", installId).get();
    return snap.exists ? (snap.get("publicKey") as string) : null;
  }

  async pinInstallKey(installId: string, publicKey: string) {
    try {
      await this.#doc("installs", installId).create({ publicKey });
      return "pinned" as const;
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
    }
    // Pinned before, possibly by a concurrent registration of the same id.
    return (await this.getInstallKey(installId)) === publicKey
      ? ("same" as const)
      : ("conflict" as const);
  }

  async getReport(reportId: string) {
    const snap = await this.#doc("reports", reportId).get();
    if (!snap.exists) return null;
    const stored = snap.data() as StoredReport;
    // A report stored before #1192 was sent without a kind: a defect.
    return { ...stored, report: { ...stored.report, kind: storedKind(stored.report.kind) } };
  }

  async putReport(report: StoredReport) {
    try {
      await this.#doc("reports", report.reportId).create(report);
    } catch (e) {
      // A retry of a report already stored writes nothing new.
      if (!isAlreadyExists(e)) throw e;
    }
  }

  async clusterIdForFingerprint(kind: BugReportKind, fingerprint: string) {
    const snap = await this.#doc(KIND_LAYOUT[kind].fingerprints, fingerprint).get();
    return snap.exists ? (snap.get("clusterId") as string) : null;
  }

  async linkFingerprint(kind: BugReportKind, fingerprint: string, clusterId: string) {
    try {
      await this.#doc(KIND_LAYOUT[kind].fingerprints, fingerprint).create({ clusterId });
      return "linked" as const;
    } catch (e) {
      if (isAlreadyExists(e)) return "taken" as const;
      throw e;
    }
  }

  async clusterIdForIssue(issueNumber: number) {
    const snap = await this.#doc("issues", String(issueNumber)).get();
    return snap.exists ? (snap.get("clusterId") as string) : null;
  }

  async linkIssue(issueNumber: number, clusterId: string) {
    await this.#doc("issues", String(issueNumber)).set({ clusterId });
  }

  async getCluster(id: string): Promise<Versioned<ClusterRecord> | null> {
    const snap = await this.#doc("clusters", id).get();
    if (!snap.exists) return null;
    return {
      value: readCluster(snap.data() as Record<string, unknown>),
      version: versionOf(snap.updateTime),
    };
  }

  async putCluster(cluster: ClusterRecord, version: string | null) {
    const ref = this.#doc("clusters", cluster.id);
    if (version === null) {
      try {
        await ref.create(cluster);
        return "ok" as const;
      } catch (e) {
        if (isAlreadyExists(e)) return "conflict" as const;
        throw e;
      }
    }
    const lastUpdateTime = timestampOf(version);
    if (lastUpdateTime === null) return "conflict" as const;
    try {
      // Every ClusterRecord key is required, so updating all top-level
      // fields replaces the whole record (and gives a pre-#1192 record its kind).
      await ref.update({ ...cluster }, { lastUpdateTime });
      return "ok" as const;
    } catch (e) {
      // Written by someone else since `version`, or deleted.
      if (grpcCode(e) === FAILED_PRECONDITION) return "conflict" as const;
      throw e;
    }
  }

  async candidates(kind: BugReportKind) {
    return this.#ensurePool(kind);
  }

  async addCandidate(summary: ClusterSummary) {
    await this.#ensurePool(summary.kind);
    const ref = this.#doc("candidates", KIND_LAYOUT[summary.kind].poolDoc);
    await this.#compareAndSet<{ items: ClusterSummary[] }, void>(ref, (cur) => {
      if (!cur) throw new Error(`${ref.path} vanished after it was built`);
      return {
        write: { items: withCandidate(readPool(cur.items), summary) },
        result: undefined,
      };
    });
  }

  /** The pool of `kind`, built from the clusters if this database has none yet (see the file header). */
  async #ensurePool(kind: BugReportKind): Promise<ClusterSummary[]> {
    const ref = this.#doc("candidates", KIND_LAYOUT[kind].poolDoc);
    const snap = await ref.get();
    if (snap.exists) return readPool(snap.get("items"));
    // The per-tool lists go first: the pool is built from the clusters, not
    // from them, so they are dead either way, and a build that stops after
    // this point simply runs again on the next request.
    const legacy = await this.db.collection("candidates").listDocuments();
    await Promise.all(
      legacy.filter((d) => d.id.startsWith(LEGACY_CANDIDATE_PREFIX)).map((d) => d.delete()),
    );
    const items = poolFromClusters(await this.#recentUnmergedClusters(kind), kind);
    try {
      await ref.create({ items });
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      // A concurrent build won; its pool is as good as this one.
      return readPool((await ref.get()).get("items"));
    }
    return items;
  }

  /**
   * Up to `MAX_CANDIDATES` unmerged clusters of `kind`, most recently
   * reported first. Filtered here rather than in the query: clusters stored
   * before #1192 have no `kind` field for a query to match.
   */
  async #recentUnmergedClusters(kind: BugReportKind): Promise<ClusterRecord[]> {
    const out: ClusterRecord[] = [];
    let query = this.db.collection("clusters").orderBy("lastSeen", "desc").limit(POOL_BUILD_PAGE);
    for (;;) {
      const page = await query.get();
      for (const d of page.docs) {
        const c = readCluster(d.data());
        if (c.mergedInto === null && c.kind === kind) out.push(c);
      }
      const last = page.docs.at(-1);
      if (out.length >= MAX_CANDIDATES || page.size < POOL_BUILD_PAGE || !last) return out;
      query = query.startAfter(last);
    }
  }

  async takeIssueSlot(kind: BugReportKind, day: string, limit: number) {
    return this.#compareAndSet<{ used: number }, boolean>(
      this.#doc(KIND_LAYOUT[kind].slots, day),
      (cur) => {
        const used = cur?.used ?? 0;
        return used >= limit
          ? { write: null, result: false }
          : { write: { used: used + 1 }, result: true };
      },
    );
  }

  async returnIssueSlot(kind: BugReportKind, day: string) {
    await this.#compareAndSet<{ used: number }, void>(
      this.#doc(KIND_LAYOUT[kind].slots, day),
      (cur) => ({
        write: cur && cur.used > 0 ? { used: cur.used - 1 } : null,
        result: undefined,
      }),
    );
  }

  async markIssuePending(kind: BugReportKind, clusterId: string, since: string) {
    try {
      await this.#doc(KIND_LAYOUT[kind].pending, clusterId).create({ since });
    } catch (e) {
      // Already queued: keep its place.
      if (!isAlreadyExists(e)) throw e;
    }
  }

  async clearIssuePending(kind: BugReportKind, clusterId: string) {
    await this.#doc(KIND_LAYOUT[kind].pending, clusterId).delete();
  }

  async pendingIssueClusters(kind: BugReportKind, limit: number) {
    const snap = await this.db
      .collection(KIND_LAYOUT[kind].pending)
      .orderBy("since")
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.id);
  }
}
