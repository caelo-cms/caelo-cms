// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 (#903, #906, #1049) — the intake's promise: one issue per
 * defect, no matter how many installs report it, how the AI words it or
 * names the tool, or whether it was captured automatically; issue state
 * flows back to the installs; nothing private reaches the public tracker.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { type BugIntakeReport, computeBugFingerprint } from "@caelo-cms/shared";
import type { IssueState, ReleaseInfo } from "./github.js";
import type { ClusterMatcher } from "./matcher.js";
import { IntakeRefusal, IntakeService, type IssueTracker } from "./service.js";
import { type ClusterSummary, MAX_CANDIDATES, MemoryStore } from "./store.js";

class FakeTracker implements IssueTracker {
  issues = new Map<number, IssueState & { title: string; body: string; labels: string[] }>();
  comments = new Map<number, string[]>();
  releasesList: ReleaseInfo[] = [];
  calls = { create: 0, update: 0, comment: 0 };
  failNextCreate = false;
  #next = 100;

  /** Every call that changes something on GitHub. */
  get writes() {
    return this.calls.create + this.calls.update + this.calls.comment;
  }

  async createIssue(i: { title: string; body: string; labels: string[] }) {
    this.calls.create++;
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("GitHub said no");
    }
    const number = this.#next++;
    const url = `https://github.com/caelo-cms/caelo-cms/issues/${number}`;
    this.issues.set(number, {
      ...i,
      number,
      url,
      state: "open",
      stateReason: null,
      closedAt: null,
    });
    return { number, url };
  }
  async updateIssue(n: number, patch: { body?: string; state?: "open" | "closed" }) {
    this.calls.update++;
    const i = this.issues.get(n)!;
    if (patch.body !== undefined) i.body = patch.body;
    if (patch.state === "open")
      Object.assign(i, { state: "open", stateReason: "reopened", closedAt: null });
  }
  async getIssue(n: number) {
    return structuredClone(this.issues.get(n)!);
  }
  async addComment(n: number, body: string) {
    this.calls.comment++;
    this.comments.set(n, [...(this.comments.get(n) ?? []), body]);
  }
  async recentCommentBodies(n: number) {
    return [...(this.comments.get(n) ?? [])].reverse();
  }
  async releases() {
    return this.releasesList;
  }
  close(n: number, reason: IssueState["stateReason"], closedAt: string, labels: string[] = []) {
    Object.assign(this.issues.get(n)!, { state: "closed", stateReason: reason, closedAt, labels });
  }
}

class FakeMatcher implements ClusterMatcher {
  answer: string | null = null;
  seen: number[] = [];
  async match(_r: BugIntakeReport, candidates: { id: string }[]) {
    this.seen.push(candidates.length);
    return this.answer;
  }
}

const INSTALL_A = "11111111-1111-4111-8111-111111111111";
const INSTALL_B = "22222222-2222-4222-8222-222222222222";
let n = 0;
const report = (over: Partial<BugIntakeReport> = {}): BugIntakeReport => ({
  protocolVersion: 1,
  reportId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  caeloVersion: "0.10.55",
  fingerprint: "a".repeat(64),
  source: "auto",
  severity: "degraded",
  blockedTask: false,
  suspectedTool: "build_page",
  title: "Tool build_page returned an error",
  whatHappened: "Page not found",
  expected: "The tool call should succeed.",
  evidence: 'Tool input: {"slug": "pricing"}',
  ...over,
});

let store: MemoryStore;
let tracker: FakeTracker;
let matcher: FakeMatcher;
let clock: Date;
const service = (
  threshold = 1,
  opts: { cap?: number; paused?: boolean; matcher?: ClusterMatcher } = {},
) =>
  new IntakeService({
    store,
    tracker,
    matcher: opts.matcher ?? matcher,
    issueThresholdInstalls: threshold,
    maxNewIssuesPerDay: opts.cap ?? 100,
    issuesPaused: opts.paused ?? false,
    now: () => clock,
  });

beforeEach(() => {
  store = new MemoryStore();
  tracker = new FakeTracker();
  matcher = new FakeMatcher();
  clock = new Date("2026-10-20T10:00:00Z");
});

describe("IntakeService", () => {
  it("files one issue on the first report and only counts repeats from other installs", async () => {
    const s = service();
    const first = await s.ingest(INSTALL_A, report());
    expect(first.status).toBe("open");
    expect(first.issueUrl).toContain("/issues/100");
    for (let i = 0; i < 5; i++) await s.ingest(INSTALL_A, report());
    const fromB = await s.ingest(INSTALL_B, report());
    expect(fromB.clusterId).toBe(first.clusterId);
    expect(tracker.calls.create).toBe(1);
    const c = (await store.getCluster(first.clusterId))!.value;
    expect(c.occurrences).toBe(7);
    expect(c.installHashes.length).toBe(2);
    // The new install refreshed the public body.
    expect(tracker.issues.get(100)?.body).toContain("| Installs reporting it | 2 |");
  });

  it("waits for the configured number of installs before filing", async () => {
    const s = service(2);
    expect((await s.ingest(INSTALL_A, report())).issueUrl).toBeNull();
    expect((await s.ingest(INSTALL_B, report())).issueUrl).toContain("/issues/");
  });

  it("is idempotent for a retried report and refuses a report id from another install", async () => {
    const s = service();
    const r = report();
    await s.ingest(INSTALL_A, r);
    await s.ingest(INSTALL_A, r);
    const c = [...store.clusters.values()][0]!.value;
    expect(c.occurrences).toBe(1);
    await expect(s.ingest(INSTALL_B, r)).rejects.toBeInstanceOf(IntakeRefusal);
  });

  it("merges a differently worded AI report through the matcher; exact repeats skip it", async () => {
    const s = service();
    const a = await s.ingest(
      INSTALL_A,
      report({ source: "ai", fingerprint: "b".repeat(64), title: "Selector crop ignored" }),
    );
    matcher.answer = a.clusterId;
    const b = await s.ingest(
      INSTALL_B,
      report({ source: "ai", fingerprint: "c".repeat(64), title: "screenshot ignores selector" }),
    );
    expect(b.clusterId).toBe(a.clusterId);
    expect(tracker.calls.create).toBe(1);
    // The new wording is now a direct hit.
    expect(await store.clusterIdForFingerprint("c".repeat(64))).toBe(a.clusterId);

    // A repeat of a known fingerprint never asks the model.
    const calls = matcher.seen.length;
    await s.ingest(INSTALL_A, report({ source: "ai", fingerprint: "c".repeat(64) }));
    expect(matcher.seen.length).toBe(calls);
  });

  it("keeps evidence and personal data off the public issue", async () => {
    const s = service();
    await s.ingest(
      INSTALL_A,
      report({
        title: "Fails for @octocat see #1",
        whatHappened: "Mail jo@example.com about https://kunde.example.de",
        evidence: "SECRET-EVIDENCE",
      }),
    );
    const issue = tracker.issues.get(100)!;
    expect(issue.body).not.toContain("SECRET-EVIDENCE");
    expect(issue.body).not.toContain("jo@example.com");
    expect(issue.body).not.toContain("kunde.example.de");
    // Free text sits in a code fence, where GitHub resolves no @mention.
    expect(issue.body).toMatch(/```text\n[^`]*\[email\]/);
    expect(issue.labels).toEqual(["ai-detected", "severity:degraded"]);
    // The private store keeps the (redacted) evidence for maintainers.
    expect([...store.reports.values()][0]?.report.evidence).toBe("SECRET-EVIDENCE");
  });

  it("reports fixed with the first release after the close, and reopens a regression", async () => {
    const s = service();
    const first = await s.ingest(INSTALL_A, report({ caeloVersion: "0.10.55" }));
    tracker.close(100, "completed", "2026-10-21T00:00:00Z");
    tracker.releasesList = [
      { version: "0.11.1", publishedAt: "2026-11-01T00:00:00Z" },
      { version: "0.11.0", publishedAt: "2026-10-25T00:00:00Z" },
      { version: "0.10.56", publishedAt: "2026-10-19T00:00:00Z" },
    ];
    clock = new Date("2026-10-26T00:00:00Z");
    const [st] = await s.status([first.clusterId]);
    expect(st).toMatchObject({ status: "fixed", fixedInVersion: "0.11.0" });

    // An install still on the old version: fixed, update to get it.
    clock = new Date("2026-10-26T01:00:00Z");
    expect(await s.ingest(INSTALL_B, report({ caeloVersion: "0.10.55" }))).toMatchObject({
      status: "fixed",
      fixedInVersion: "0.11.0",
    });

    // From a version with the fix: it came back.
    clock = new Date("2026-10-27T00:00:00Z");
    const again = await s.ingest(INSTALL_A, report({ caeloVersion: "0.11.0" }));
    expect(again.status).toBe("regression");
    expect(tracker.issues.get(100)?.state).toBe("open");
    expect(tracker.comments.get(100)?.at(-1)).toContain("regression");
  });

  it("a report whose filing version is unknown never reopens a fixed issue (#1072)", async () => {
    const s = service();
    const first = await s.ingest(INSTALL_A, report({ caeloVersion: "0.10.55" }));
    tracker.close(100, "completed", "2026-10-21T00:00:00Z");
    tracker.releasesList = [{ version: "0.11.0", publishedAt: "2026-10-25T00:00:00Z" }];
    clock = new Date("2026-10-26T00:00:00Z");
    expect((await s.status([first.clusterId]))[0]).toMatchObject({ status: "fixed" });

    clock = new Date("2026-10-27T00:00:00Z");
    const again = await s.ingest(INSTALL_B, report({ caeloVersion: "unknown" }));
    expect(again.status).toBe("fixed");
    expect(tracker.issues.get(100)?.state).not.toBe("open");
  });

  it("honours a fixed-in label and maps not-planned to wontfix", async () => {
    const s = service();
    const a = await s.ingest(INSTALL_A, report());
    tracker.close(100, "completed", "2026-10-21T00:00:00Z", ["fixed-in:v0.10.60"]);
    clock = new Date("2026-10-22T00:00:00Z");
    expect((await s.status([a.clusterId]))[0]?.fixedInVersion).toBe("0.10.60");

    const b = await s.ingest(INSTALL_A, report({ fingerprint: "e".repeat(64) }));
    tracker.close(101, "not_planned", "2026-10-22T00:00:00Z");
    clock = new Date("2026-10-23T00:00:00Z");
    expect((await s.status([b.clusterId]))[0]?.status).toBe("wontfix");
  });

  it("follows a maintainer's 'close as duplicate' to the original cluster", async () => {
    const s = service();
    const original = await s.ingest(INSTALL_A, report({ fingerprint: "1".repeat(64) }));
    const dup = await s.ingest(INSTALL_A, report({ fingerprint: "2".repeat(64) }));
    await tracker.addComment(101, "Duplicate of #100");
    tracker.close(101, "duplicate", "2026-10-21T00:00:00Z");
    clock = new Date("2026-10-22T00:00:00Z");
    const [st] = await s.status([dup.clusterId]);
    expect(st?.issueUrl).toBe(original.issueUrl);
    // Later reports of the duplicate's fingerprint count on the original.
    await s.ingest(INSTALL_B, report({ fingerprint: "2".repeat(64) }));
    expect((await store.getCluster(original.clusterId))?.value.installHashes.length).toBe(2);
  });

  it("comments once when a defect reaches an install milestone", async () => {
    const s = service();
    for (let i = 0; i < 10; i++) {
      await s.ingest(`33333333-3333-4333-8333-${String(i).padStart(12, "0")}`, report());
    }
    expect(tracker.comments.get(100)).toEqual(["Now reported from 10+ installs."]);
    await s.ingest(INSTALL_A, report());
    expect(tracker.comments.get(100)?.length).toBe(1);
  });

  it("caps new issues per UTC day, files the queued defect after the reset, and keeps updating existing issues", async () => {
    const s = service(1, { cap: 1 });
    const first = await s.ingest(INSTALL_A, report());
    expect(first.issueUrl).toContain("/issues/100");

    // Over today's cap: stored and counted, but no issue yet.
    const capped = await s.ingest(INSTALL_A, report({ fingerprint: "f".repeat(64) }));
    expect(capped.issueUrl).toBeNull();
    expect((await store.getCluster(capped.clusterId))?.value.occurrences).toBe(1);
    expect(await store.pendingIssueClusters(10)).toEqual([capped.clusterId]);
    expect(tracker.calls.create).toBe(1);

    // The cap is on new issues only: the existing one still gets its counters.
    const updates = tracker.calls.update;
    await s.ingest(INSTALL_B, report());
    expect(tracker.calls.update).toBe(updates + 1);
    expect(tracker.issues.get(100)?.body).toContain("| Installs reporting it | 2 |");
    await s.ingest(INSTALL_B, report({ fingerprint: "f".repeat(64) }));
    expect(tracker.calls.create).toBe(1);

    // Still the same UTC day, one second before midnight: nothing new.
    clock = new Date("2026-10-20T23:59:59Z");
    await s.status([first.clusterId]);
    expect(tracker.calls.create).toBe(1);

    // After the reset, any request files the queue, even one about another cluster.
    clock = new Date("2026-10-21T00:00:01Z");
    await s.status([first.clusterId]);
    expect(tracker.calls.create).toBe(2);
    const filed = (await store.getCluster(capped.clusterId))!.value;
    expect(filed.issueUrl).toContain("/issues/101");
    expect(tracker.issues.get(101)?.body).toContain("| Installs reporting it | 2 |");
    expect(await store.pendingIssueClusters(10)).toEqual([]);
    expect(store.issueSlots.get("2026-10-21")).toBe(1);
  });

  it("files queued defects oldest first, a bounded batch per request", async () => {
    const s = service(1, { cap: 1 });
    await s.ingest(INSTALL_A, report({ fingerprint: "0".repeat(64) }));
    const queued: string[] = [];
    for (const [i, fp] of ["5", "6", "7", "8", "9"].entries()) {
      clock = new Date(`2026-10-20T1${i}:00:00Z`);
      queued.push((await s.ingest(INSTALL_A, report({ fingerprint: fp.repeat(64) }))).clusterId);
    }
    const big = service(1, { cap: 100 });
    clock = new Date("2026-10-21T08:00:00Z");
    await big.status([]);
    // Three per request, in arrival order.
    expect(await store.pendingIssueClusters(10)).toEqual(queued.slice(3));
    expect((await store.getCluster(queued[0]!))?.value.issueNumber).toBe(101);
    await big.status([]);
    expect(await store.pendingIssueClusters(10)).toEqual([]);
  });

  it("gives the slot back and keeps the defect queued when GitHub refuses the create", async () => {
    const s = service(1, { cap: 1 });
    tracker.failNextCreate = true;
    await expect(s.ingest(INSTALL_A, report())).rejects.toThrow("GitHub said no");
    expect(store.issueSlots.get("2026-10-20")).toBe(0);
    expect(await store.pendingIssueClusters(10)).toHaveLength(1);
    // The next request retries it within the same day's budget.
    await s.status([]);
    expect(tracker.issues.get(100)).toBeDefined();
    expect(await store.pendingIssueClusters(10)).toEqual([]);
  });

  it("writes nothing to GitHub while paused, then catches up when unpaused", async () => {
    // An existing issue, closed as fixed in 0.10.60.
    const live = service();
    const a = await live.ingest(INSTALL_A, report());
    tracker.close(100, "completed", "2026-10-21T00:00:00Z", ["fixed-in:v0.10.60"]);
    clock = new Date("2026-10-22T00:00:00Z");
    await live.status([a.clusterId]);
    const before = tracker.writes;

    const paused = service(1, { paused: true });
    // New defect, a new install + version on the existing issue, and a
    // report from the fixed version that would normally reopen it.
    const fresh = await paused.ingest(INSTALL_A, report({ fingerprint: "9".repeat(64) }));
    const again = await paused.ingest(INSTALL_B, report({ caeloVersion: "0.10.61" }));
    await paused.status([a.clusterId, fresh.clusterId]);

    expect(tracker.writes).toBe(before);
    expect(fresh.issueUrl).toBeNull();
    expect(again.status).toBe("fixed");
    expect(tracker.issues.get(100)?.state).toBe("closed");
    // Reports were still accepted, counted and kept.
    expect(store.reports.size).toBe(3);
    expect((await store.getCluster(a.clusterId))?.value.installHashes.length).toBe(2);
    expect(await store.pendingIssueClusters(10)).toEqual([fresh.clusterId]);

    // Unpaused: the queued defect is filed, and the regression is caught on its next report.
    const resumed = service();
    clock = new Date("2026-10-22T01:00:00Z");
    expect((await resumed.ingest(INSTALL_B, report({ caeloVersion: "0.10.61" }))).status).toBe(
      "regression",
    );
    expect((await store.getCluster(fresh.clusterId))?.value.issueUrl).toContain("/issues/101");
  });

  it("pins the first key per install and refuses a different one", async () => {
    const s = service();
    await s.register(INSTALL_A, "key-1");
    await s.register(INSTALL_A, "key-1");
    await expect(s.register(INSTALL_A, "key-2")).rejects.toMatchObject({ status: 409 });
  });
});

/**
 * A stand-in for the model that recognises a defect by its error signal,
 * whatever the wording or tool name, and answers like the real matcher
 * would: a high-confidence id only for an offered candidate of the same
 * defect. It takes a few milliseconds, as a model call does, so reports
 * that are not serialised would overlap.
 */
class DefectMatcher implements ClusterMatcher {
  offered: ClusterSummary[][] = [];
  constructor(readonly signals: RegExp[]) {}
  #defect(text: string): number {
    return this.signals.findIndex((s) => s.test(text));
  }
  async match(r: BugIntakeReport, candidates: ClusterSummary[]) {
    this.offered.push(structuredClone(candidates));
    await new Promise((done) => setTimeout(done, 5));
    const defect = this.#defect(`${r.title}\n${r.whatHappened}`);
    if (defect === -1) return null;
    return (
      candidates.find((c) => this.#defect(`${c.title}\n${c.whatHappened}`) === defect)?.id ?? null
    );
  }
}

const FIREBASE_400 =
  'Firebase Hosting API 400 INVALID_ARGUMENT: "updateMask=expireTime" is not a valid field for this channel.';
const TBT_FLIP =
  "Lighthouse Total Blocking Time flips between 0 ms and 400 ms on unchanged pages, so the performance score jumps by 20 points between runs.";

/** A report as an install sends it, fingerprint computed the install's way. */
async function sent(
  over: Pick<BugIntakeReport, "source" | "suspectedTool" | "title" | "whatHappened">,
): Promise<BugIntakeReport> {
  return report({ ...over, fingerprint: await computeBugFingerprint(over) });
}

describe("IntakeService matching over one candidate pool (#1049)", () => {
  const INSTALL_C = "44444444-4444-4444-8444-444444444444";
  const INSTALL_D = "55555555-5555-4555-8555-555555555555";
  let defects: DefectMatcher;
  beforeEach(() => {
    defects = new DefectMatcher([/updateMask=expireTime/, /Total Blocking Time/]);
  });

  it("files the six live reports of two defects (issue #1049's table) as two clusters", async () => {
    const s = service(1, { matcher: defects });
    const r1037 = await s.ingest(
      INSTALL_A,
      await sent({
        source: "auto",
        suspectedTool: "stage_changes",
        title: "Tool stage_changes returned an error",
        whatHappened: FIREBASE_400,
      }),
    );
    const r1039 = await s.ingest(
      INSTALL_B,
      await sent({
        source: "ai",
        suspectedTool: "stage_changes",
        title: "Staging fails: Firebase refuses the channel's expireTime update",
        whatHappened: `stage_changes failed. ${FIREBASE_400}`,
      }),
    );
    // #1047 and #1048 came from one install about a second apart.
    const [r1047, r1048] = await Promise.all([
      s.ingest(
        INSTALL_C,
        await sent({
          source: "ai",
          suspectedTool: "stage_changes (Firebase Hosting staging channel promotion)",
          title: "Promoting the staging channel fails with a 400",
          whatHappened: `The staging channel could not be promoted: ${FIREBASE_400}`,
        }),
      ),
      s.ingest(
        INSTALL_C,
        await sent({
          source: "ai",
          suspectedTool: "stage_changes (static-publisher-firebase selectStagingPreview)",
          title: "selectStagingPreview sends an invalid update mask",
          whatHappened: `selectStagingPreview patched the channel and got: ${FIREBASE_400}`,
        }),
      ),
    ]);
    const r1043 = await s.ingest(
      INSTALL_A,
      await sent({
        source: "ai",
        suspectedTool: "quality audit (Lighthouse runner)",
        title: "Quality audit performance score is unstable",
        whatHappened: TBT_FLIP,
      }),
    );
    const r1046 = await s.ingest(
      INSTALL_D,
      await sent({
        source: "ai",
        suspectedTool: "get_quality_audit / Lighthouse runner, site web fonts",
        title: "Lighthouse TBT differs between identical audits (web fonts?)",
        whatHappened: `Suspect the site web fonts. ${TBT_FLIP}`,
      }),
    );

    const firebase = new Set([r1037, r1039, r1047, r1048].map((r) => r.clusterId));
    const tbt = new Set([r1043, r1046].map((r) => r.clusterId));
    expect(firebase.size).toBe(1);
    expect(tbt.size).toBe(1);
    expect(firebase).not.toEqual(tbt);
    expect(store.clusters.size).toBe(2);
    expect(tracker.calls.create).toBe(2);
  });

  it("joins an AI report to the auto cluster of the same error, and an auto capture to an AI cluster", async () => {
    const s = service(1, { matcher: defects });
    const auto = await s.ingest(
      INSTALL_A,
      await sent({
        source: "auto",
        suspectedTool: "stage_changes",
        title: "Tool stage_changes returned an error",
        whatHappened: FIREBASE_400,
      }),
    );
    const followUp = await s.ingest(
      INSTALL_A,
      await sent({
        source: "ai",
        suspectedTool: "stage_changes",
        title: "Stage fails on the expireTime update",
        whatHappened: FIREBASE_400,
      }),
    );
    expect(followUp.clusterId).toBe(auto.clusterId);
    // The matcher was told the candidate is an automatic capture, and of which tool.
    expect(defects.offered.at(-1)).toEqual([
      expect.objectContaining({
        id: auto.clusterId,
        source: "auto",
        suspectedTool: "stage_changes",
      }),
    ]);

    // The other direction: the AI reported first, the auto capture of the error follows.
    const ai = await s.ingest(
      INSTALL_B,
      await sent({
        source: "ai",
        suspectedTool: "quality audit (Lighthouse runner)",
        title: "Performance score unstable",
        whatHappened: TBT_FLIP,
      }),
    );
    const capture = await s.ingest(
      INSTALL_B,
      await sent({
        source: "auto",
        suspectedTool: "get_quality_audit",
        title: "Tool get_quality_audit returned an error",
        whatHappened: TBT_FLIP,
      }),
    );
    expect(capture.clusterId).toBe(ai.clusterId);
    expect(store.clusters.size).toBe(2);
    expect(tracker.calls.create).toBe(2);
  });

  it("ends two back-to-back reports of one new defect from one install in one cluster", async () => {
    const s = service(1, { matcher: defects });
    const variants = [
      { tool: "stage_changes", title: "Stage fails with a 400" },
      { tool: "stage_changes (Firebase)", title: "Firebase refuses the update mask" },
    ];
    const results = await Promise.all(
      variants.map(async (v) =>
        s.ingest(
          INSTALL_C,
          await sent({
            source: "ai",
            suspectedTool: v.tool,
            title: v.title,
            whatHappened: FIREBASE_400,
          }),
        ),
      ),
    );
    expect(results[0]?.clusterId).toBe(results[1]!.clusterId);
    expect(store.clusters.size).toBe(1);
    // The second report was matched against the cluster the first one created.
    expect(defects.offered.map((o) => o.length)).toEqual([0, 1]);
  });

  it("keeps the pool bounded and newest first, and moves a matched cluster to the front", async () => {
    const s = service(1, { matcher: defects });
    const ids: string[] = [];
    for (let i = 0; i < MAX_CANDIDATES + 5; i++) {
      const r = await s.ingest(
        INSTALL_A,
        await sent({
          source: "ai",
          suspectedTool: `tool_${i}`,
          title: `Defect number ${i}`,
          whatHappened: `Symptom ${i}`,
        }),
      );
      ids.push(r.clusterId);
    }
    const pool = await store.candidates();
    expect(pool.length).toBe(MAX_CANDIDATES);
    expect(pool.map((c) => c.id)).toEqual(ids.slice(-MAX_CANDIDATES).reverse());
    expect(Math.max(...defects.offered.map((o) => o.length))).toBe(MAX_CANDIDATES);

    // A cluster still in the pool that gains a new wording is the newest again.
    const old = ids[10]!;
    const stub: ClusterMatcher = { match: async () => old };
    const joined = await service(1, { matcher: stub }).ingest(
      INSTALL_B,
      await sent({ source: "ai", suspectedTool: "tool_10", title: "Reworded", whatHappened: "x" }),
    );
    expect(joined.clusterId).toBe(old);
    expect((await store.candidates())[0]?.id).toBe(old);
    expect((await store.candidates()).length).toBe(MAX_CANDIDATES);
  });

  it("offers clusters stored before the pool existed, leaving merged ones out", async () => {
    // A store from before #1049: clusters, no pool yet.
    const base = (await service().ingest(INSTALL_A, report())).clusterId;
    const record = (await store.getCluster(base))!.value;
    store.pool = null;
    await store.putCluster(
      {
        ...record,
        id: "c_auto_old",
        source: "auto",
        whatHappened: FIREBASE_400,
        lastSeen: "2026-10-23T09:00:00Z",
      },
      null,
    );
    await store.putCluster({ ...record, id: "c_merged", mergedInto: base }, null);
    const r = await service(1, { matcher: defects }).ingest(
      INSTALL_B,
      await sent({
        source: "ai",
        suspectedTool: "stage_changes (Firebase Hosting staging channel promotion)",
        title: "Promotion fails",
        whatHappened: FIREBASE_400,
      }),
    );
    expect(r.clusterId).toBe("c_auto_old");
    expect(defects.offered[0]?.map((c) => c.id).sort()).toEqual([base, "c_auto_old"].sort());
  });
});
