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
 *   - a cluster's version is its document `updateTime`, and `putCluster`
 *     replaces it only inside a transaction that re-reads that time;
 *   - read-modify-write lists and counters run in transactions.
 *
 * Credentials: the client authenticates with Application Default
 * Credentials (the Cloud Run service account). There is no key-file path on
 * purpose. With `FIRESTORE_EMULATOR_HOST` set, the SDK talks to the emulator.
 */

import { Firestore, type Timestamp } from "@google-cloud/firestore";
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

function isAlreadyExists(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === ALREADY_EXISTS;
}

/** Document update time as an opaque, exactly comparable version string. */
function versionOf(t: Timestamp | undefined): string {
  if (!t) throw new Error("Firestore returned an existing document without an update time");
  return `${t.seconds}.${String(t.nanoseconds).padStart(9, "0")}`;
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
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || versionOf(snap.updateTime) !== version) return "conflict" as const;
      tx.set(ref, cluster);
      return "ok" as const;
    });
  }

  async candidates(toolKey: string) {
    const snap = await this.#doc("candidates", candidateDocId(toolKey)).get();
    return snap.exists ? (snap.get("items") as ClusterSummary[]) : [];
  }

  async addCandidate(toolKey: string, summary: ClusterSummary) {
    const ref = this.#doc("candidates", candidateDocId(toolKey));
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists ? (snap.get("items") as ClusterSummary[]) : [];
      const items = [summary, ...cur.filter((x) => x.id !== summary.id)].slice(
        0,
        MAX_CANDIDATES_PER_TOOL,
      );
      tx.set(ref, { items });
    });
  }

  async takeIssueSlot(day: string, limit: number) {
    const ref = this.#doc("issueSlots", day);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const used = snap.exists ? (snap.get("used") as number) : 0;
      if (used >= limit) return false;
      tx.set(ref, { used: used + 1 });
      return true;
    });
  }

  async returnIssueSlot(day: string) {
    const ref = this.#doc("issueSlots", day);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const used = snap.exists ? (snap.get("used") as number) : 0;
      if (used > 0) tx.set(ref, { used: used - 1 });
    });
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
