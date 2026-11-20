// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { FEED_ENTRY_LIMIT } from "@caelo-cms/shared";
import { ContentStates, type RecordedPage } from "./content-states.js";

const PUBLISH_AT = "2026-11-20T12:00:00.000Z";
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
/** A full build never reads the database in finish(). */
const NO_TX = {} as TransactionRunner;

function page(id: string, over: Partial<RecordedPage> = {}): RecordedPage {
  return {
    pageId: id,
    url: `https://example.com/${id}/`,
    fingerprint: FP_A,
    title: `Page ${id}`,
    summary: "",
    firstPublishedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    ...over,
  };
}

function states(
  live: Record<string, { url: string | null; fingerprint: string | null; changedAt: string }>,
  base: number | null = 7,
  full = true,
) {
  return ContentStates.fromRecord({
    base,
    live: new Map(Object.entries(live)),
    publishAt: PUBLISH_AT,
    full,
  });
}

describe("ContentStates", () => {
  it("keeps the date of an unchanged page and records no change", async () => {
    const s = states({
      p1: {
        url: "https://example.com/p1/",
        fingerprint: FP_A,
        changedAt: "2026-11-01T00:00:00.000Z",
      },
    });
    s.record(page("p1"));
    expect(s.changedAt("p1")).toBe("2026-11-01T00:00:00.000Z");
    expect((await s.finish(NO_TX)).changes).toEqual([]);
  });

  it("dates a changed page with the build and records the change", async () => {
    const s = states({
      p1: {
        url: "https://example.com/p1/",
        fingerprint: FP_A,
        changedAt: "2026-11-01T00:00:00.000Z",
      },
    });
    s.record(page("p1", { fingerprint: FP_B }));
    expect(s.changedAt("p1")).toBe(PUBLISH_AT);
    expect((await s.finish(NO_TX)).changes).toEqual([
      {
        pageId: "p1",
        kind: "changed",
        url: "https://example.com/p1/",
        fingerprint: FP_B,
        prevUrl: "https://example.com/p1/",
        changedAt: PUBLISH_AT,
      },
    ]);
  });

  it("records a new URL as moved, with the URL it had", async () => {
    const s = states({
      p1: {
        url: "https://example.com/old/",
        fingerprint: FP_A,
        changedAt: "2026-11-01T00:00:00.000Z",
      },
    });
    s.record(page("p1"));
    const [c] = (await s.finish(NO_TX)).changes;
    expect(c?.kind).toBe("moved");
    expect(c?.prevUrl).toBe("https://example.com/old/");
  });

  it("records a page the record never had as added once the record exists", async () => {
    const s = states({});
    s.record(page("p1"));
    expect((await s.finish(NO_TX)).changes[0]?.kind).toBe("added");
    expect(s.changedAt("p1")).toBe(PUBLISH_AT);
  });

  it("records a page that was removed and is back as added", async () => {
    const s = states({
      p1: { url: null, fingerprint: null, changedAt: "2026-11-01T00:00:00.000Z" },
    });
    s.record(page("p1"));
    expect((await s.finish(NO_TX)).changes[0]?.kind).toBe("added");
  });

  it("before the record began, a page live already is the baseline, dated by its last edit", async () => {
    const s = states({}, null);
    s.record(page("p1"));
    s.record(page("p2", { firstPublishedAt: null }));
    const { changes } = await s.finish(NO_TX);
    expect(changes.map((c) => [c.pageId, c.kind, c.changedAt])).toEqual([
      ["p1", "baseline", "2026-10-05T00:00:00.000Z"],
      ["p2", "added", PUBLISH_AT],
    ]);
  });

  it("never dates a baseline before the page went live or after the build", async () => {
    const s = states({}, null);
    s.record(page("early", { updatedAt: "2026-01-01T00:00:00.000Z" }));
    s.record(page("late", { updatedAt: "2027-01-01T00:00:00.000Z" }));
    expect(s.changedAt("early")).toBe("2026-10-01T00:00:00.000Z");
    expect(s.changedAt("late")).toBe(PUBLISH_AT);
  });

  it("a full build records the live pages it no longer ships as removed", async () => {
    const s = states({
      p1: {
        url: "https://example.com/p1/",
        fingerprint: FP_A,
        changedAt: "2026-11-01T00:00:00.000Z",
      },
      gone: {
        url: "https://example.com/gone/",
        fingerprint: FP_A,
        changedAt: "2026-11-01T00:00:00.000Z",
      },
      wasGone: { url: null, fingerprint: null, changedAt: "2026-11-01T00:00:00.000Z" },
    });
    s.record(page("p1"));
    expect((await s.finish(NO_TX)).changes).toEqual([
      {
        pageId: "gone",
        kind: "removed",
        url: null,
        fingerprint: null,
        prevUrl: "https://example.com/gone/",
        changedAt: PUBLISH_AT,
      },
    ]);
  });

  it("an incremental build removes nothing it did not render", async () => {
    const s = states(
      {
        other: {
          url: "https://example.com/other/",
          fingerprint: FP_A,
          changedAt: "2026-11-01T00:00:00.000Z",
        },
      },
      7,
      false,
    );
    s.record(page("p1"));
    // The other page stays live: only its feed entry is read (none here,
    // the fake tx answers no rows).
    const tx = { execute: async () => [] } as unknown as TransactionRunner;
    expect((await s.finish(tx)).changes.map((c) => c.kind)).toEqual(["added"]);
  });

  it("feeds the pages changed last, newest first, at most the limit", async () => {
    const s = states({}, 1);
    for (let i = 0; i < FEED_ENTRY_LIMIT + 5; i += 1) {
      s.record(page(`p${String(i).padStart(3, "0")}`));
    }
    const { feed } = await s.finish(NO_TX);
    expect(feed).toHaveLength(FEED_ENTRY_LIMIT);
    // All carry the build's date: the URL orders the tie.
    expect(feed[0]?.url).toBe("https://example.com/p000/");
  });

  it("refuses a page recorded twice", () => {
    const s = states({});
    s.record(page("p1"));
    expect(() => s.record(page("p1"))).toThrow("recorded twice");
  });
});
