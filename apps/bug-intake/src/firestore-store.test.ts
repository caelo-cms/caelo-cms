// SPDX-License-Identifier: MPL-2.0

/**
 * #980 — `FirestoreStore` against the Firestore emulator: every
 * `IntakeStore` method, including the races the service relies on
 * (first key wins, first fingerprint link wins, a stale cluster version is
 * refused, a lost compare-and-set re-reads instead of overwriting, so the
 * daily issue cap cannot be exceeded).
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
import { type ClusterRecord, MAX_CANDIDATES_PER_TOOL, type StoredReport } from "./store.js";

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

/** Forward every other property to the real object, bound to it, so the SDK never sees a proxy. */
function forward<T extends object>(target: T, prop: string | symbol): unknown {
  const v = Reflect.get(target, prop, target);
  return typeof v === "function" ? v.bind(target) : v;
}

/**
 * A store on the same database in which, for the next `times` reads of
 * `collection/id`, `interfere()` commits another writer's change after the
 * read and before the store writes. `raced()` reports how often it fired,
 * so a test proves the race actually happened.
 */
function racedStore(
  collection: string,
  id: string,
  interfere: () => Promise<void>,
  times = 1,
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
  const db = new Proxy(s().db, {
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

  live("keeps the newest candidates per tool, deduplicated and capped", async () => {
    expect(await s().candidates("build_page")).toEqual([]);
    await s().addCandidate("build_page", { id: "c_first", title: "t", whatHappened: "w" });
    // Another writer adds a candidate between this writer's read and write:
    // the stale write is refused and re-read, so neither entry is lost.
    const { store: raced, raced: fired } = racedStore("candidates", "t_build_page", () =>
      s().addCandidate("build_page", { id: "c_other", title: "t", whatHappened: "w" }),
    );
    await raced.addCandidate("build_page", { id: "c_mine", title: "t", whatHappened: "w" });
    expect(fired()).toBe(1);
    expect((await s().candidates("build_page")).map((c) => c.id)).toEqual([
      "c_mine",
      "c_other",
      "c_first",
    ]);
    for (let i = 0; i < MAX_CANDIDATES_PER_TOOL + 2; i++) {
      await s().addCandidate("edit_module", { id: `c_${i}`, title: `t${i}`, whatHappened: "w" });
    }
    await s().addCandidate("edit_module", { id: "c_5", title: "again", whatHappened: "w" });
    const list = await s().candidates("edit_module");
    expect(list.length).toBe(MAX_CANDIDATES_PER_TOOL);
    expect(list[0]).toEqual({ id: "c_5", title: "again", whatHappened: "w" });
    expect(list.filter((c) => c.id === "c_5").length).toBe(1);
    // Keys Firestore would refuse as document ids still work.
    await s().addCandidate(".", { id: "c_dot", title: "t", whatHappened: "w" });
    expect((await s().candidates("."))[0]?.id).toBe("c_dot");
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
