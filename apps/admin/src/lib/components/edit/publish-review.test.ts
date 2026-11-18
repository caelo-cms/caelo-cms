// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PublishPreview } from "@caelo-cms/admin-core";
import {
  confirmedRedirects,
  examplePages,
  groupRedirects,
  pageBreakdown,
  reviewPageHref,
  reviewPages,
  shipsNothingVisible,
} from "./publish-review.js";

const group = (paths: string[]) => ({
  total: paths.length,
  items: paths.map((path, i) => ({ pageId: `${path}-${i}`, title: path, path })),
});

function preview(pages: {
  new?: string[];
  changed?: string[];
  removed?: string[];
}): PublishPreview {
  return {
    staged: { runId: "s", startedAt: "2026-11-17T10:00:00Z", finishedAt: null },
    live: { runId: "l", finishedAt: null, stagedRunId: "x" },
    liveMatchesStaging: false,
    notice: null,
    pages: {
      new: group(pages.new ?? []),
      changed: group(pages.changed ?? []),
      removed: group(pages.removed ?? []),
    },
    siteWide: [],
    settings: [],
  };
}

describe("groupRedirects", () => {
  it("makes one row of pages that moved from one folder to another", () => {
    const moved = ["a", "b", "c"].map((n) => ({
      fromPath: `/blog/2024/${n}`,
      toPath: `/news/${n}`,
    }));
    const groups = groupRedirects([
      ...moved,
      { fromPath: "/plans", toPath: "/pricing" },
      { fromPath: "/old", toPath: null },
    ]);
    expect(groups).toEqual([
      { label: "/blog/2024/… → /news/…", count: 3 },
      { label: "/old (removed)", count: 1 },
      { label: "/plans → /pricing", count: 1 },
    ]);
  });

  it("keeps a single move and a redirect to another website as their rule", () => {
    expect(
      groupRedirects([
        { fromPath: "/docs/v1/install", toPath: "/docs/install" },
        { fromPath: "/partners", toPath: "https://partners.example.com/partners" },
      ]).map((g) => g.label),
    ).toEqual([
      "/docs/v1/install → /docs/install",
      "/partners → https://partners.example.com/partners",
    ]);
  });
});

describe("the review's pages", () => {
  it("shows one example of each kind first", () => {
    const p = preview({ new: ["/n1", "/n2"], changed: ["/c1", "/c2"], removed: ["/r1"] });
    expect(examplePages(reviewPages(p)).map((x) => x.path)).toEqual(["/n1", "/c1", "/r1"]);
  });

  it("fills the examples from the list when a kind is missing", () => {
    const p = preview({ changed: ["/c1", "/c2", "/c3", "/c4"] });
    expect(examplePages(reviewPages(p)).map((x) => x.path)).toEqual(["/c1", "/c2", "/c3"]);
  });

  it("writes the breakdown without the kinds that have no page", () => {
    expect(pageBreakdown(preview({ new: ["/a"], removed: ["/b", "/c"] }))).toBe(
      "1 new · 2 removed",
    );
    expect(pageBreakdown(preview({}))).toBe("none");
  });
});

describe("the review's form", () => {
  const plan = {
    goingLive: [{ id: "r1", revision: 3, fromPath: "/a", toPath: "/b", origin: "manual" }],
    waiting: [],
    draft: [],
    problem: null,
  };

  it("posts back exactly the redirects it showed as going live", () => {
    expect(JSON.parse(confirmedRedirects(plan))).toEqual([{ id: "r1", revision: 3 }]);
  });

  it("tells a release with nothing visible apart", () => {
    expect(
      shipsNothingVisible({ preview: preview({}), redirects: { ...plan, goingLive: [] } }),
    ).toBe(true);
    expect(shipsNothingVisible({ preview: preview({}), redirects: plan })).toBe(false);
  });
});

describe("reviewPageHref", () => {
  it("opens a new or changed page on the protected staging host through Open staging", () => {
    expect(reviewPageHref({ kind: "gate" }, { path: "/de/preise", change: "changed" })).toBe(
      "/staging/open?path=%2Fde%2Fpreise",
    );
    expect(reviewPageHref({ kind: "gate" }, { path: "/", change: "new" })).toBe("/staging/open");
  });

  it("opens the page on the local staging port in a development checkout", () => {
    expect(
      reviewPageHref(
        { kind: "origin", origin: "http://localhost:8081" },
        { path: "/de/preise", change: "new" },
      ),
    ).toBe("http://localhost:8081/de/preise");
  });

  it("has no link for a removed page, a page without a path or an install without staging", () => {
    expect(reviewPageHref({ kind: "gate" }, { path: "/old", change: "removed" })).toBeNull();
    expect(reviewPageHref({ kind: "gate" }, { path: null, change: "changed" })).toBeNull();
    expect(reviewPageHref(null, { path: "/de/preise", change: "changed" })).toBeNull();
  });
});
