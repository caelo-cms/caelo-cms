// SPDX-License-Identifier: MPL-2.0

/**
 * Production store of the bug intake (#980): one Firestore database that
 * belongs to the intake alone.
 *
 *   installs/<installId>          { publicKey }
 *   reports/<reportId>            StoredReport
 *   fingerprints/<fingerprint>    { clusterId }
 *   issues/<number>               { clusterId }
 *   clusters/<clusterId>          ClusterRecord
 *   candidates/t_<toolKey>        { items: ClusterSummary[] }
 *   issueSlots/<YYYY-MM-DD>       { used }
 *   pendingIssues/<clusterId>     { since }
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
 * Credentials: the client authenticates with Application Default
 * Credentials (the Cloud Run service account). There is no key-file path on
 * purpose. With `FIRESTORE_EMULATOR_HOST` set, the SDK talks to the emulator.
 */

import { type DocumentReference, Firestore, Timestamp } from "@google-cloud/firestore";
import {
  type ClusterRecord,
  type ClusterSummary,
  type IntakeStore,
  MAX_CANDIDATES_PER_TOOL,
  type StoredReport,
  type Versioned,
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

/**
 * Tool keys may be `.` or `..`, which Firestore refuses as document ids;
 * the prefix makes every key a valid id without changing what it groups.
 */
function candidateDocId(toolKey: string): string {
  return `t_${toolKey}`;
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
    return snap.exists ? (snap.data() as StoredReport) : null;
  }

  async putReport(report: StoredReport) {
    try {
      await this.#doc("reports", report.reportId).create(report);
    } catch (e) {
      // A retry of a report already stored writes nothing new.
      if (!isAlreadyExists(e)) throw e;
    }
  }

  async clusterIdForFingerprint(fingerprint: string) {
    const snap = await this.#doc("fingerprints", fingerprint).get();
    return snap.exists ? (snap.get("clusterId") as string) : null;
  }

  async linkFingerprint(fingerprint: string, clusterId: string) {
    try {
      await this.#doc("fingerprints", fingerprint).create({ clusterId });
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
    return { value: snap.data() as ClusterRecord, version: versionOf(snap.updateTime) };
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
      // fields replaces the whole record.
      await ref.update({ ...cluster }, { lastUpdateTime });
      return "ok" as const;
    } catch (e) {
      // Written by someone else since `version`, or deleted.
      if (grpcCode(e) === FAILED_PRECONDITION) return "conflict" as const;
      throw e;
    }
  }

  async candidates(toolKey: string) {
    const snap = await this.#doc("candidates", candidateDocId(toolKey)).get();
    return snap.exists ? (snap.get("items") as ClusterSummary[]) : [];
  }

  async addCandidate(toolKey: string, summary: ClusterSummary) {
    await this.#compareAndSet<{ items: ClusterSummary[] }, void>(
      this.#doc("candidates", candidateDocId(toolKey)),
      (cur) => ({
        write: {
          items: [summary, ...(cur?.items ?? []).filter((x) => x.id !== summary.id)].slice(
            0,
            MAX_CANDIDATES_PER_TOOL,
          ),
        },
        result: undefined,
      }),
    );
  }

  async takeIssueSlot(day: string, limit: number) {
    return this.#compareAndSet<{ used: number }, boolean>(this.#doc("issueSlots", day), (cur) => {
      const used = cur?.used ?? 0;
      return used >= limit
        ? { write: null, result: false }
        : { write: { used: used + 1 }, result: true };
    });
  }

  async returnIssueSlot(day: string) {
    await this.#compareAndSet<{ used: number }, void>(this.#doc("issueSlots", day), (cur) => ({
      write: cur && cur.used > 0 ? { used: cur.used - 1 } : null,
      result: undefined,
    }));
  }

  async markIssuePending(clusterId: string, since: string) {
    try {
      await this.#doc("pendingIssues", clusterId).create({ since });
    } catch (e) {
      // Already queued: keep its place.
      if (!isAlreadyExists(e)) throw e;
    }
  }

  async clearIssuePending(clusterId: string) {
    await this.#doc("pendingIssues", clusterId).delete();
  }

  async pendingIssueClusters(limit: number) {
    const snap = await this.db.collection("pendingIssues").orderBy("since").limit(limit).get();
    return snap.docs.map((d) => d.id);
  }
}
