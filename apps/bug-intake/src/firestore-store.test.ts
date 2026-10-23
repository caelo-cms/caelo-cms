// SPDX-License-Identifier: MPL-2.0

/**
 * #980 — `FirestoreStore` against the Firestore emulator: every
 * `IntakeStore` method, including the races the service relies on
 * (first key wins, first fingerprint link wins, a stale cluster version is
 * refused, a lost compare-and-set re-reads instead of overwriting, so the
 * daily issue cap cannot be exceeded), and the candidate pool of #1049,
 * including its first build from a database that holds clusters and the
 * old per-tool candidate lists.
 *
 * Races are forced, not hoped for: `racedStore` lets another writer commit
 * between the store's read and its write, which is exactly the losing side
 * of a race, deterministically and in milliseconds. Firing simultaneous
 * commits instead would mostly measure the emulator: it makes a commit that
 * collides with another on the same document wait ~2 s for a lock (even a
 * plain create or precondition update), which production Firestore does not.
 *
 * Needs the emulator: set `FIRESTORE_EMULATOR_HOST` (e.g. start it with
 * `gcloud emulators firestore start --host-port=127.0.0.1:8915`). Without
 * it the suite skips and says so. CI sets `CAELO_FIRESTORE_EMULATOR=required`,
 * which turns a missing emulator into a failure, so this suite can never
 * silently stop running there. Each run uses its own project id, so runs
 * never see each other's documents.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { BugIntakeReport } from "@caelo-cms/shared";
import { type DocumentReference, Firestore } from "@google-cloud/firestore";
import { FirestoreStore } from "./firestore-store.js";
import { IntakeService, type IssueTracker } from "./service.js";
import {
  type ClusterRecord,
  type ClusterSummary,
  clusterSummary,
  MAX_CANDIDATES,
  type StoredReport,
} from "./store.js";

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const REQUIRED = process.env.CAELO_FIRESTORE_EMULATOR === "required";

if (!EMULATOR) {
  console.warn(
    "[firestore-store.test] SKIPPED: FIRESTORE_EMULATOR_HOST is not set, so FirestoreStore is untested in this run. " +
      "Start the emulator (gcloud emulators firestore start --host-port=127.0.0.1:8915) and export FIRESTORE_EMULATOR_HOST=127.0.0.1:8915.",
  );
}

const store = EMULATOR
  ? new FirestoreStore(
      new Firestore({
        projectId: `bug-intake-test-${crypto.randomUUID().slice(0, 8)}`,
        ignoreUndefinedProperties: true,
      }),
    )
  : null;
const s = () => store as FirestoreStore;

/**
 * An empty database of its own (a new emulator project), for tests that
 * need to know every document in a collection, such as the pool build.
 */
const freshDb = () =>
  new Firestore({
    projectId: `bug-intake-test-${crypto.randomUUID().slice(0, 8)}`,
    ignoreUndefinedProperties: true,
  });

const summary = (
  id: string,
  suspectedTool: string | null,
  source: "ai" | "auto" = "ai",
): ClusterSummary => ({ id, title: `title of ${id}`, whatHappened: "w", suspectedTool, source });

/** Forward every other property to the real object, bound to it, so the SDK never sees a proxy. */
function forward<T extends object>(target: T, prop: string | symbol): unknown {
  const v = Reflect.get(target, prop, target);
  return typeof v === "function" ? v.bind(target) : v;
}

/**
 * A store on the same database in which, for the next `times` reads of
 * `collection/id`, `interfere()` commits another writer's change after the
 * read and before the store writes. `raced()` reports how often it fired,
 * so a test proves the race actually happened. `base` is the database (the
 * suite's shared one unless a test brought its own).
 */
function racedStore(
  collection: string,
  id: string,
  interfere: () => Promise<void>,
  times = 1,
  base: Firestore = s().db,
): { store: FirestoreStore; raced: () => number } {
  let fired = 0;
  const wrapRef = (ref: DocumentReference) =>
    new Proxy(ref, {
      get(target, prop) {
        if (prop !== "get") return forward(target, prop);
        return async () => {
          const snap = await target.get();
          if (fired < times) {
            fired++;
            await interfere();
          }
          return snap;
        };
      },
    });
  const db = new Proxy(base, {
    get(target, prop) {
      if (prop !== "collection") return forward(target, prop);
      return (name: string) => {
        const col = target.collection(name);
        if (name !== collection) return col;
        return new Proxy(col, {
          get(c, p) {
            if (p !== "doc") return forward(c, p);
            return (docId: string) => (docId === id ? wrapRef(c.doc(docId)) : c.doc(docId));
          },
        });
      };
    },
  });
  return { store: new FirestoreStore(db), raced: () => fired };
}

async function slotsUsed(day: string): Promise<number | undefined> {
  return (await s().db.collection("issueSlots").doc(day).get()).get("used") as number | undefined;
}

const cluster = (id: string, over: Partial<ClusterRecord> = {}): ClusterRecord => ({
  id,
  createdAt: "2026-10-21T10:00:00.000Z",
  source: "ai",
  suspectedTool: "build_page",
  title: "Build fails",
  whatHappened: "It failed",
  expected: "It works",
  severity: "degraded",
  blockedTask: false,
  fingerprints: ["a".repeat(64)],
  installHashes: [],
  occurrences: 0,
  versions: [],
  firstSeen: "2026-10-21T10:00:00.000Z",
  lastSeen: "2026-10-21T10:00:00.000Z",
  issueNumber: null,
  issueUrl: null,
  status: "open",
  fixedInVersion: null,
  mergedInto: null,
  lastIssueSyncAt: null,
  milestonesCommented: [],
  ...over,
});

const sentReport = (over: Partial<BugIntakeReport> = {}): BugIntakeReport => ({
  protocolVersion: 1,
  reportId: crypto.randomUUID(),
  caeloVersion: "0.10.61",
  fingerprint: "b".repeat(64),
  source: "auto",
  severity: "degraded",
  blockedTask: false,
  suspectedTool: "build_page",
  title: "Tool build_page returned an error",
  whatHappened: "Page not found",
  expected: "The tool call should succeed.",
  evidence: "private evidence",
  ...over,
});

describe("FirestoreStore against the emulator (#980)", () => {
  if (REQUIRED) {
    it("the emulator is configured (CAELO_FIRESTORE_EMULATOR=required)", () => {
      expect(EMULATOR).toBeDefined();
    });
  }
  /**
   * Every test runs on a 5 s budget with wide headroom (each is tens of
   * milliseconds): the store never blocks, and the races are forced rather
   * than timed, so a slow test here means the store started waiting.
   */
  const live = (name: string, fn: () => Promise<void>) => it.skipIf(!EMULATOR)(name, fn, 5_000);

  // Only the first call is slow: it opens the gRPC channel to the emulator.
  beforeAll(async () => {
    if (store) await store.getInstallKey("warm-up");
  }, 60_000);

  live("pins the first key per install and refuses any other", async () => {
    expect(await s().getInstallKey("inst-1")).toBeNull();
    expect(await s().pinInstallKey("inst-1", "key-a")).toBe("pinned");
    // The second registration of the id lost the race, whatever its key.
    expect(await s().pinInstallKey("inst-1", "key-b")).toBe("conflict");
    expect(await s().pinInstallKey("inst-1", "key-a")).toBe("same");
    expect(await s().getInstallKey("inst-1")).toBe("key-a");
  });

  live("stores reports first-write-wins, evidence included", async () => {
    const report = sentReport();
    const stored: StoredReport = {
      reportId: report.reportId,
      installHash: "h1",
      receivedAt: "2026-10-21T10:00:00.000Z",
      clusterId: "c_1",
      report,
    };
    expect(await s().getReport(report.reportId)).toBeNull();
    await s().putReport(stored);
    await s().putReport({ ...stored, clusterId: "c_other" });
    expect(await s().getReport(report.reportId)).toEqual(stored);
  });

  live("links a fingerprint once; the second link is taken and changes nothing", async () => {
    const fp = "c".repeat(64);
    expect(await s().clusterIdForFingerprint(fp)).toBeNull();
    expect(await s().linkFingerprint(fp, "c_x")).toBe("linked");
    expect(await s().linkFingerprint(fp, "c_y")).toBe("taken");
    expect(await s().clusterIdForFingerprint(fp)).toBe("c_x");
  });

  live("maps issues to clusters, last link wins", async () => {
    expect(await s().clusterIdForIssue(42)).toBeNull();
    await s().linkIssue(42, "c_a");
    await s().linkIssue(42, "c_b");
    expect(await s().clusterIdForIssue(42)).toBe("c_b");
  });

  live("versions clusters: create once, replace only the version read", async () => {
    expect(await s().getCluster("c_v")).toBeNull();
    expect(await s().putCluster(cluster("c_v"), "1.000000000")).toBe("conflict");
    expect(await s().putCluster(cluster("c_v"), null)).toBe("ok");
    expect(await s().putCluster(cluster("c_v"), null)).toBe("conflict");

    const read = (await s().getCluster("c_v"))!;
    expect(read.value).toEqual(cluster("c_v"));
    expect(await s().putCluster({ ...read.value, occurrences: 1 }, read.version)).toBe("ok");
    // Someone else's write already replaced the version this caller read.
    expect(await s().putCluster({ ...read.value, occurrences: 99 }, read.version)).toBe("conflict");
    const after = (await s().getCluster("c_v"))!;
    expect(after.value.occurrences).toBe(1);
    expect(after.version).not.toBe(read.version);
  });

  live("refuses a cluster write whose version another writer replaced in between", async () => {
    await s().putCluster(cluster("c_race"), null);
    const read = (await s().getCluster("c_race"))!;
    const { store: raced, raced: fired } = racedStore("clusters", "c_race", async () => {
      expect(await s().putCluster({ ...read.value, occurrences: 1 }, read.version)).toBe("ok");
    });
    const stale = (await raced.getCluster("c_race"))!;
    expect(fired()).toBe(1);
    expect(await raced.putCluster({ ...stale.value, occurrences: 2 }, stale.version)).toBe(
      "conflict",
    );
    expect((await s().getCluster("c_race"))?.value.occurrences).toBe(1);
  });

  live(
    "keeps one candidate pool of every tool, newest first, deduplicated and capped",
    async () => {
      const db = freshDb();
      const pool = new FirestoreStore(db);
      expect(await pool.candidates()).toEqual([]);
      await pool.addCandidate(summary("c_first", "build_page"));
      // Another writer adds a candidate between this writer's read and write:
      // the stale write is refused and re-read, so neither entry is lost.
      const { store: raced, raced: fired } = racedStore(
        "candidates",
        "pool",
        () => pool.addCandidate(summary("c_other", "stage_changes (Firebase)", "auto")),
        1,
        db,
      );
      await raced.addCandidate(summary("c_mine", "stage_changes"));
      expect(fired()).toBe(1);
      expect((await pool.candidates()).map((c) => c.id)).toEqual(["c_mine", "c_other", "c_first"]);
      expect((await pool.candidates())[1]).toEqual(
        summary("c_other", "stage_changes (Firebase)", "auto"),
      );
      for (let i = 0; i < MAX_CANDIDATES + 2; i++) {
        await pool.addCandidate(summary(`c_${i}`, `tool_${i}`));
      }
      await pool.addCandidate({ ...summary("c_5", "tool_5"), title: "again" });
      const list = await pool.candidates();
      expect(list.length).toBe(MAX_CANDIDATES);
      expect(list[0]).toEqual({ ...summary("c_5", "tool_5"), title: "again" });
      expect(list.filter((c) => c.id === "c_5").length).toBe(1);
    },
  );

  live(
    "builds the pool from the clusters a database already holds and drops the per-tool lists",
    async () => {
      // The live database before #1049: AI candidates bucketed per tool
      // wording, the auto cluster in no bucket at all, one cluster merged.
      const db = freshDb();
      const before = new FirestoreStore(db);
      const fixtures = [
        cluster("c_1037", {
          source: "auto",
          suspectedTool: "stage_changes",
          lastSeen: "2026-10-23T08:00:00.000Z",
        }),
        cluster("c_1039", { suspectedTool: "stage_changes", lastSeen: "2026-10-23T09:00:00.000Z" }),
        cluster("c_1047", {
          suspectedTool: "stage_changes (Firebase Hosting staging channel promotion)",
          lastSeen: "2026-10-23T11:00:00.000Z",
        }),
        cluster("c_1043", {
          suspectedTool: "quality audit (Lighthouse runner)",
          lastSeen: "2026-10-23T10:00:00.000Z",
        }),
        cluster("c_merged", { mergedInto: "c_1039", lastSeen: "2026-10-23T12:00:00.000Z" }),
      ];
      for (const c of fixtures) expect(await before.putCluster(c, null)).toBe("ok");
      const legacy = [
        "t_stage_changes",
        "t_stage_changes__firebase_hosting_staging_channel_promotion_",
        "t_quality_audit__lighthouse_runner_",
      ];
      for (const id of legacy) {
        await db
          .collection("candidates")
          .doc(id)
          .set({ items: [{ id: "c_1039", title: "t", whatHappened: "w" }] });
      }

      // Another process builds the pool between this one's read and create:
      // the losing create re-reads instead of failing or overwriting.
      let b: ClusterSummary[] = [];
      const { store: raced, raced: fired } = racedStore(
        "candidates",
        "pool",
        async () => {
          b = await new FirestoreStore(db).candidates();
        },
        1,
        db,
      );
      const a = await raced.candidates();
      expect(fired()).toBe(1);
      expect(a).toEqual(b);
      expect(a.map((c) => c.id)).toEqual(["c_1047", "c_1043", "c_1039", "c_1037"]);
      expect(a.find((c) => c.id === "c_1037")).toEqual(clusterSummary(fixtures[0]!));
      const left = (await db.collection("candidates").listDocuments()).map((d) => d.id);
      expect(left).toEqual(["pool"]);

      // From now on the pool is kept, not rebuilt.
      await before.addCandidate(summary("c_new", "build_page"));
      expect((await before.candidates()).map((c) => c.id)).toEqual([
        "c_new",
        "c_1047",
        "c_1043",
        "c_1039",
        "c_1037",
      ]);
    },
  );

  live("builds the pool on the first add, paging past merged clusters", async () => {
    const db = freshDb();
    const st = new FirestoreStore(db);
    // 160 clusters, the 70 most recently reported merged: the first build
    // page (100) holds only 30 unmerged ones, so the build reads a second.
    await Promise.all(
      Array.from({ length: 160 }, (_, i) =>
        st.putCluster(
          cluster(`c_${String(i).padStart(3, "0")}`, {
            lastSeen: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
            mergedInto: i >= 90 ? "c_000" : null,
          }),
          null,
        ),
      ),
    );
    await st.addCandidate(summary("c_fresh", "build_page"));
    const ids = (await st.candidates()).map((c) => c.id);
    expect(ids.length).toBe(MAX_CANDIDATES);
    expect(ids.slice(0, 3)).toEqual(["c_fresh", "c_089", "c_088"]);
    expect(ids.at(-1)).toBe(`c_0${89 - MAX_CANDIDATES + 2}`);
  });

  live("hands out at most `limit` issue slots per day and gives them back", async () => {
    expect(await s().takeIssueSlot("2026-10-21", 2)).toBe(true);
    expect(await s().takeIssueSlot("2026-10-21", 2)).toBe(true);
    expect(await s().takeIssueSlot("2026-10-21", 2)).toBe(false);
    expect(await s().takeIssueSlot("2026-10-22", 2)).toBe(true);
    await s().returnIssueSlot("2026-10-21");
    expect(await slotsUsed("2026-10-21")).toBe(1);
    expect(await s().takeIssueSlot("2026-10-21", 2)).toBe(true);
    expect(await s().takeIssueSlot("2026-10-21", 2)).toBe(false);
    // Returning on a day with nothing taken never goes below zero.
    await s().returnIssueSlot("2026-10-30");
    expect(await slotsUsed("2026-10-30")).toBeUndefined();
    expect(await s().takeIssueSlot("2026-10-30", 1)).toBe(true);
    expect(await s().takeIssueSlot("2026-10-30", 1)).toBe(false);
  });

  live("never exceeds the cap when another taker wins the last slot in between", async () => {
    const day = "2026-11-10";
    await s().takeIssueSlot(day, 3);
    await s().takeIssueSlot(day, 3);
    // This taker reads used=2, then the other one takes the last slot.
    const { store: raced, raced: fired } = racedStore("issueSlots", day, async () => {
      expect(await s().takeIssueSlot(day, 3)).toBe(true);
    });
    expect(await raced.takeIssueSlot(day, 3)).toBe(false);
    expect(fired()).toBe(1);
    expect(await slotsUsed(day)).toBe(3);
  });

  live("counts both takers when the day's counter is created in between", async () => {
    const day = "2026-11-11";
    // This taker reads "no counter yet"; the other one creates it first.
    const { store: raced, raced: fired } = racedStore("issueSlots", day, async () => {
      expect(await s().takeIssueSlot(day, 3)).toBe(true);
    });
    expect(await raced.takeIssueSlot(day, 3)).toBe(true);
    expect(fired()).toBe(1);
    expect(await slotsUsed(day)).toBe(2);
  });

  live("loses no return when another writer changes the counter in between", async () => {
    const day = "2026-11-12";
    await s().takeIssueSlot(day, 5);
    await s().takeIssueSlot(day, 5);
    const { store: raced, raced: fired } = racedStore("issueSlots", day, () =>
      s().returnIssueSlot(day),
    );
    await raced.returnIssueSlot(day);
    expect(fired()).toBe(1);
    expect(await slotsUsed(day)).toBe(0);
  });

  live("gives up loudly when every attempt loses its race", async () => {
    const day = "2026-11-13";
    let n = 0;
    const { store: raced } = racedStore(
      "issueSlots",
      day,
      async () => {
        // Another writer changes the counter after every one of this writer's reads.
        await s().takeIssueSlot(day, 1_000);
        n++;
      },
      Number.POSITIVE_INFINITY,
    );
    await expect(raced.takeIssueSlot(day, 1_000)).rejects.toThrow(
      "issueSlots/2026-11-13: 10 write conflicts in a row",
    );
    expect(n).toBe(10);
    expect(await slotsUsed(day)).toBe(10);
  });

  live("queues pending issues oldest first and keeps the original place", async () => {
    await s().markIssuePending("c_late", "2026-10-21T12:00:00.000Z");
    await s().markIssuePending("c_early", "2026-10-21T09:00:00.000Z");
    await s().markIssuePending("c_late", "2026-10-21T01:00:00.000Z");
    expect(await s().pendingIssueClusters(10)).toEqual(["c_early", "c_late"]);
    expect(await s().pendingIssueClusters(1)).toEqual(["c_early"]);
    await s().clearIssuePending("c_early");
    await s().clearIssuePending("c_missing");
    expect(await s().pendingIssueClusters(10)).toEqual(["c_late"]);
    await s().clearIssuePending("c_late");
  });

  live("carries the intake service end to end, including the daily cap", async () => {
    const created: number[] = [];
    const tracker: IssueTracker = {
      createIssue: async () => {
        const n = 500 + created.length;
        created.push(n);
        return { number: n, url: `https://github.com/caelo-cms/caelo-cms/issues/${n}` };
      },
      updateIssue: async () => {},
      getIssue: async (n) => ({
        number: n,
        url: `https://github.com/caelo-cms/caelo-cms/issues/${n}`,
        state: "open",
        stateReason: null,
        closedAt: null,
        labels: [],
      }),
      addComment: async () => {},
      recentCommentBodies: async () => [],
      releases: async () => [],
    };
    let clock = new Date("2026-11-01T10:00:00Z");
    const service = new IntakeService({
      store: s(),
      tracker,
      matcher: { match: async () => null },
      issueThresholdInstalls: 1,
      maxNewIssuesPerDay: 1,
      issuesPaused: false,
      now: () => clock,
    });
    const a = await service.ingest("install-a", sentReport({ fingerprint: "d".repeat(64) }));
    const again = await service.ingest("install-b", sentReport({ fingerprint: "d".repeat(64) }));
    expect(again.clusterId).toBe(a.clusterId);
    expect(a.issueUrl).toContain("/issues/500");
    const capped = await service.ingest("install-a", sentReport({ fingerprint: "e".repeat(64) }));
    expect(capped.issueUrl).toBeNull();
    expect((await s().getCluster(a.clusterId))?.value.occurrences).toBe(2);

    clock = new Date("2026-11-02T00:10:00Z");
    await service.status([a.clusterId]);
    expect(created).toEqual([500, 501]);
    expect((await s().getCluster(capped.clusterId))?.value.issueNumber).toBe(501);
    expect(await s().clusterIdForIssue(501)).toBe(capped.clusterId);
  });
});
