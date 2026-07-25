// SPDX-License-Identifier: MPL-2.0

/**
 * Unit coverage for the pure compose-eligibility decisions extracted from
 * `imports.compose_from_run` (ops/compose-eligibility.ts). No DB — the two
 * migration-chat failure classes these guard are:
 *
 *  1. "run is crawling" surfacing as a RED error card (it must be a
 *     structured, non-error "keep polling" outcome).
 *  2. compose creating templates but SILENTLY zero pages (it must name
 *     the skipped pages and, when zero pages result, fail loudly).
 */

import { describe, expect, it } from "bun:test";
import {
  buildZeroPagesAbortMessage,
  COMPOSE_CRAWL_RETRY_MS,
  type ComposeSkip,
  classifyComposeRunStatus,
} from "../ops/compose-eligibility.js";

const RUN_ID = "11111111-1111-1111-1111-111111111111";

describe("classifyComposeRunStatus", () => {
  it("composes when the run is ready_for_review or completed", () => {
    expect(classifyComposeRunStatus("ready_for_review", RUN_ID)).toEqual({ kind: "compose" });
    expect(classifyComposeRunStatus("completed", RUN_ID)).toEqual({ kind: "compose" });
  });

  it("treats a still-crawling / not-yet-started run as NOT-READY, not an error", () => {
    const crawling = classifyComposeRunStatus("crawling", RUN_ID);
    expect(crawling).toEqual({
      kind: "not_ready",
      runStatus: "crawling",
      retryAfterMs: COMPOSE_CRAWL_RETRY_MS,
    });
    const proposed = classifyComposeRunStatus("proposed", RUN_ID);
    expect(proposed).toEqual({
      kind: "not_ready",
      runStatus: "proposed",
      retryAfterMs: COMPOSE_CRAWL_RETRY_MS,
    });
    // The load-bearing property: crawling is never the error verdict.
    expect(crawling.kind).not.toBe("error");
  });

  it("treats a failed or unknown run as a loud error naming the run id", () => {
    const failed = classifyComposeRunStatus("failed", RUN_ID);
    expect(failed.kind).toBe("error");
    if (failed.kind === "error") {
      expect(failed.message).toContain(RUN_ID);
      expect(failed.message).toContain("failed");
      expect(failed.message).toContain("ready_for_review");
    }
    // An unexpected/garbage status is also a hard error, never silent.
    expect(classifyComposeRunStatus("banana", RUN_ID).kind).toBe("error");
  });
});

describe("buildZeroPagesAbortMessage", () => {
  it("names every skipped page + its reason and states nothing was applied", () => {
    const skipped: ComposeSkip[] = [
      {
        importPageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        slug: "about",
        sourceUrl: "https://example.com/about",
        reason: "screenshot-diff FAIL not acknowledged",
      },
      {
        importPageId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        slug: "pricing",
        sourceUrl: "https://example.com/pricing",
        reason: "screenshot-diff FAIL not acknowledged",
      },
    ];
    const msg = buildZeroPagesAbortMessage(2, skipped);
    expect(msg).toContain("ZERO pages");
    expect(msg).toContain("2 template(s)");
    expect(msg).toContain("about");
    expect(msg).toContain("pricing");
    expect(msg.toLowerCase()).toContain("rolled back");
  });

  it("degrades to a clear message when there are no recorded skips", () => {
    const msg = buildZeroPagesAbortMessage(1, []);
    expect(msg).toContain("ZERO pages");
    expect(msg).toContain("no eligible pages");
  });
});
