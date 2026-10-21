// SPDX-License-Identifier: MPL-2.0

/**
 * #980 — `FirestoreStore` against the Firestore emulator: every
 * `IntakeStore` method, including the races the service relies on
 * (first key wins, first fingerprint link wins, a stale cluster version is
 * refused, the daily issue cap holds under concurrent takers).
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
import { Firestore } from "@google-cloud/firestore";
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
   * The emulator serialises contended transactions with lock waits of a few
   * seconds, and the first call opens the gRPC channel; both are emulator
   * latency, not store behaviour, so live tests get a generous budget.
   */
  const live = (name: string, fn: () => Promise<void>) => it.skipIf(!EMULATOR)(name, fn, 30_000);

  beforeAll(async () => {
    if (store) await store.getInstallKey("warm-up");
  }, 60_000);

  live("pins the first key per install, concurrently too", async () => {
    expect(await s().getInstallKey("inst-1")).toBeNull();
    const results = await Promise.all([
      s().pinInstallKey("inst-1", "key-a"),
      s().pinInstallKey("inst-1", "key-b"),
    ]);
    expect(results.sort()).toEqual(["conflict", "pinned"]);
    const winner = (await s().getInstallKey("inst-1")) as string;
    expect(await s().pinInstallKey("inst-1", winner)).toBe("same");
    expect(await s().pinInstallKey("inst-1", winner === "key-a" ? "key-b" : "key-a")).toBe(
      "conflict",
    );
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

  live("links a fingerprint once; a concurrent second link is taken", async () => {
    const fp = "c".repeat(64);
    expect(await s().clusterIdForFingerprint(fp)).toBeNull();
    const results = await Promise.all([
      s().linkFingerprint(fp, "c_x"),
      s().linkFingerprint(fp, "c_y"),
    ]);
    expect(results.sort()).toEqual(["linked", "taken"]);
    expect(["c_x", "c_y"]).toContain((await s().clusterIdForFingerprint(fp)) as string);
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

  live("lets exactly one of two racing writers of the same version win", async () => {
    await s().putCluster(cluster("c_race"), null);
    const read = (await s().getCluster("c_race"))!;
    const results = await Promise.all([
      s().putCluster({ ...read.value, occurrences: 1 }, read.version),
      s().putCluster({ ...read.value, occurrences: 2 }, read.version),
    ]);
    expect(results.sort()).toEqual(["conflict", "ok"]);
  });

  live("keeps the newest candidates per tool, deduplicated and capped", async () => {
    expect(await s().candidates("build_page")).toEqual([]);
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        s().addCandidate("build_page", { id: `c_${i}`, title: `t${i}`, whatHappened: "w" }),
      ),
    );
    expect((await s().candidates("build_page")).map((c) => c.id).sort()).toEqual([
      "c_0",
      "c_1",
      "c_2",
      "c_3",
      "c_4",
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

  live("hands out exactly `limit` issue slots per day under concurrency", async () => {
    const taken = await Promise.all(
      Array.from({ length: 6 }, () => s().takeIssueSlot("2026-10-21", 3)),
    );
    expect(taken.filter(Boolean).length).toBe(3);
    expect(await s().takeIssueSlot("2026-10-22", 3)).toBe(true);
    await s().returnIssueSlot("2026-10-21");
    expect(await s().takeIssueSlot("2026-10-21", 3)).toBe(true);
    expect(await s().takeIssueSlot("2026-10-21", 3)).toBe(false);
    // Returning on a day with nothing taken never goes below zero.
    await s().returnIssueSlot("2026-10-30");
    await s().returnIssueSlot("2026-10-30");
    expect(await s().takeIssueSlot("2026-10-30", 1)).toBe(true);
    expect(await s().takeIssueSlot("2026-10-30", 1)).toBe(false);
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
