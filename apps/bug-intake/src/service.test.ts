// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 (#903, #906) — the intake's promise: one issue per defect, no
 * matter how many installs report it or how the AI words it; issue state
 * flows back to the installs; nothing private reaches the public tracker.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { BugIntakeReport } from "@caelo-cms/shared";
import type { IssueState, ReleaseInfo } from "./github.js";
import type { ClusterMatcher } from "./matcher.js";
import { IntakeRefusal, IntakeService, type IssueTracker } from "./service.js";
import { MemoryStore } from "./store.js";

class FakeTracker implements IssueTracker {
  issues = new Map<number, IssueState & { title: string; body: string; labels: string[] }>();
  comments = new Map<number, string[]>();
  releasesList: ReleaseInfo[] = [];
  calls = { create: 0, update: 0 };
  #next = 100;

  async createIssue(i: { title: string; body: string; labels: string[] }) {
    this.calls.create++;
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
const service = (threshold = 1) =>
  new IntakeService({
    store,
    tracker,
    matcher,
    issueThresholdInstalls: threshold,
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

  it("merges a differently worded AI report through the matcher, and only AI reports", async () => {
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

    const calls = matcher.seen.length;
    await s.ingest(INSTALL_A, report({ source: "auto", fingerprint: "d".repeat(64) }));
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

  it("pins the first key per install and refuses a different one", async () => {
    const s = service();
    await s.register(INSTALL_A, "key-1");
    await s.register(INSTALL_A, "key-1");
    await expect(s.register(INSTALL_A, "key-2")).rejects.toMatchObject({ status: 409 });
  });
});
