// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  describeSearchIndexProgress,
  describeStageRun,
  formatStageDuration,
  type StageStatusRun,
  searchIndexPending,
} from "./stage-status.js";

const base: StageStatusRun = {
  runId: "00000000-0000-0000-0000-000000001288",
  targetName: "staging",
  status: "running",
  phase: "building",
  pagesDone: 812,
  pagesTotal: 1904,
  startedAt: "2026-11-01T07:00:00.000Z",
  finishedAt: null,
  elapsedMs: 60_000,
  error: null,
  failedPhase: null,
  eta: { remainingMs: 100_000, basis: "this_run_rate", includesPublish: true },
  etaUnavailable: null,
};

describe("formatStageDuration", () => {
  it("reads like a person would say it", () => {
    expect(formatStageDuration(45_000)).toBe("45 s");
    expect(formatStageDuration(100_000)).toBe("1 min 40 s");
    expect(formatStageDuration(120_000)).toBe("2 min");
    expect(formatStageDuration(725_000)).toBe("12 min");
  });
});

describe("describeStageRun", () => {
  it("states progress and the estimate with its basis", () => {
    expect(describeStageRun(base)).toBe(
      "Building pages 812 of 1,904 — about 1 min 40 s left (from this run's pace)",
    );
  });

  it("says when the estimate covers the pages only", () => {
    expect(
      describeStageRun({
        ...base,
        eta: { remainingMs: 30_000, basis: "this_run_rate", includesPublish: false },
      }),
    ).toContain("pages only — publishing time unknown");
  });

  it("names why there is no estimate instead of a number", () => {
    expect(
      describeStageRun({
        ...base,
        phase: "preparing",
        pagesDone: null,
        pagesTotal: null,
        eta: null,
        etaUnavailable: "no successful Stage has recorded its step times yet",
      }),
    ).toBe(
      "Preparing the build (1 min so far) — no estimate: no successful Stage has recorded its step times yet",
    );
  });

  it("gives a failed run's step and reason", () => {
    expect(
      describeStageRun({
        ...base,
        status: "failed",
        phase: "failed",
        elapsedMs: 94_736,
        error: "122 render failure(s)",
        failedPhase: "generator",
        eta: null,
      }),
    ).toBe("Failed in generator after 1 min 35 s: 122 render failure(s)");
  });
});

describe("a succeeded Stage whose search index still embeds", () => {
  const built: StageStatusRun = {
    ...base,
    status: "succeeded",
    phase: "succeeded",
    pagesDone: 320,
    pagesTotal: 320,
    eta: null,
    elapsedMs: 300_000,
  };
  const indexing = (progress?: {
    embedded: number;
    toEmbed: number;
    tasks: number;
    remainingMs: number | null;
  }): StageStatusRun => ({
    ...built,
    searchIndexes: [
      { plugin: "site-search", collection: "anchors", state: "ready", error: null },
      {
        plugin: "site-search",
        collection: "pages",
        state: "pending",
        error: null,
        ...(progress ? { progress } : {}),
      },
    ],
  });

  it("says how far the embedding is, on how many tasks, and how long Publish live still waits", () => {
    const run = indexing({ embedded: 2_400, toEmbed: 5_152, tasks: 4, remainingMs: 190_000 });
    expect(searchIndexPending(run)).toBe(true);
    expect(describeStageRun(run)).toBe(
      "Succeeded in 5 min (320 pages); search index still building (site-search/pages: semantic search 2,400 of 5,152 passages on 4 tasks, about 3 min 10 s left) — Publish live waits for it",
    );
  });

  it("names the step after the embedding, and a pace not measured yet", () => {
    expect(describeSearchIndexProgress({ embedded: 9, toEmbed: 9, tasks: 1, remainingMs: 0 })).toBe(
      "semantic search 9 of 9 passages, writing the index",
    );
    expect(
      describeSearchIndexProgress({ embedded: 0, toEmbed: 9, tasks: 1, remainingMs: null }),
    ).toBe("semantic search 0 of 9 passages, time left not measured yet");
  });

  it("says only the name while nothing is embedded, and nothing pending once ready", () => {
    expect(describeStageRun(indexing())).toContain(
      "search index still building (site-search/pages) — Publish live waits for it",
    );
    const ready: StageStatusRun = {
      ...built,
      searchIndexes: [{ plugin: "site-search", collection: "pages", state: "ready", error: null }],
    };
    expect(searchIndexPending(ready)).toBe(false);
    expect(describeStageRun(ready)).toContain("search index ready");
  });
});
