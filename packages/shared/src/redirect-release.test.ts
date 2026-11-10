// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — which Staged redirect changes a build serves: a change waits for
 * its target, an automatic removal waits for its page, and the live state
 * stays where a change waits.
 */

import { describe, expect, it } from "bun:test";
import type { RedirectTableRow } from "./redirect-plan.js";
import { redirectPathServed } from "./redirect-plan.js";
import {
  applyRedirectChanges,
  type PendingRedirectChange,
  planRedirectRelease,
  redirectAddress,
} from "./redirect-release.js";

const row = (fromPath: string, toPath: string, statusCode = 301): RedirectTableRow => ({
  fromPath,
  toPath,
  statusCode,
});

const change = (
  id: string,
  fromPath: string,
  toPath: string | null,
  extra: Partial<PendingRedirectChange> = {},
): PendingRedirectChange => ({
  id,
  address: redirectAddress(fromPath),
  fromPath,
  toPath,
  statusCode: toPath === null ? null : 301,
  automatic: false,
  ...extra,
});

const files = (...paths: string[]) => new Set(paths);
const plan = (
  live: RedirectTableRow[],
  changes: PendingRedirectChange[],
  servedFiles: ReadonlySet<string>,
) => planRedirectRelease({ live, changes, servedFiles, pageUrlStyle: "directory" });

describe("redirectAddress / redirectPathServed", () => {
  it("one address for both spellings, the root stays the root", () => {
    expect(redirectAddress("/old/")).toBe("/old");
    expect(redirectAddress("/old")).toBe("/old");
    expect(redirectAddress("/")).toBe("/");
  });

  it("a page's directory index, a bare-slug file and a file answer their path", () => {
    const served = files("index.html", "about/index.html", "terms", "doc.pdf");
    expect(redirectPathServed("/", served)).toBe(true);
    expect(redirectPathServed("/about/", served)).toBe(true);
    expect(redirectPathServed("/about?x=1", served)).toBe(true);
    expect(redirectPathServed("/terms", served)).toBe(true);
    expect(redirectPathServed("/doc.pdf", served)).toBe(true);
    expect(redirectPathServed("/missing", served)).toBe(false);
  });
});

describe("applyRedirectChanges", () => {
  it("replaces both spellings of an address, removes, creates, keeps the rest", () => {
    const live = [row("/a/", "/x"), row("/b", "/y"), row("/c", "/z")];
    const rows = applyRedirectChanges(live, [
      change("1", "/a", "/new"),
      change("2", "/b", null),
      change("3", "/d", "/w"),
    ]);
    expect(rows).toEqual([row("/a", "/new"), row("/c", "/z"), row("/d", "/w")]);
  });
});

describe("planRedirectRelease", () => {
  const served = files("index.html", "about/index.html", "new/index.html");

  it("applies a change whose target the build serves", () => {
    const r = plan([], [change("1", "/old", "/new")], served);
    expect(r.applied).toEqual(["1"]);
    expect(r.waiting).toEqual([]);
    expect(r.rows).toEqual([row("/old", "/new")]);
  });

  it("a change to a page the build does not have waits, and the address keeps its live rule", () => {
    const r = plan([row("/old", "/about")], [change("1", "/old", "/draft-page")], served);
    expect(r.applied).toEqual([]);
    expect(r.waiting).toEqual([{ id: "1", reason: "target" }]);
    expect(r.rows).toEqual([row("/old", "/about")]);
  });

  it("an external target, an /api target and a 410 never wait", () => {
    const r = plan(
      [],
      [
        change("1", "/qr", "https://booking.example.org/x", { statusCode: 302 }),
        change("2", "/hook", "/api/plugin/x"),
        change("3", "/gone", "/410", { statusCode: 410 }),
      ],
      served,
    );
    expect(r.applied.sort()).toEqual(["1", "2", "3"]);
    expect(r.waiting).toEqual([]);
  });

  it("a target that is itself a served redirect counts as served (chains collapse)", () => {
    const r = plan([row("/mid", "/about")], [change("1", "/old", "/mid")], served);
    expect(r.applied).toEqual(["1"]);
    expect(r.plan.redirects.find((p) => p.fromPath === "/old")?.location).toBe("/about/");
  });

  it("leaving one change out leaves out the change whose chain went through it", () => {
    // /a → /b → /c, where /c is not in the build: /b waits, then /a ends at
    // /b (no rule, no page) and waits too.
    const r = plan([], [change("a", "/a", "/b"), change("b", "/b", "/c")], served);
    expect(r.applied).toEqual([]);
    expect(r.waiting.map((w) => w.id).sort()).toEqual(["a", "b"]);
    expect(r.rows).toEqual([]);
  });

  it("an automatic removal waits until the build serves the page at its address", () => {
    const takeOver = change("1", "/new-home", null, { automatic: true });
    const before = plan([row("/new-home", "/about")], [takeOver], served);
    expect(before.waiting).toEqual([{ id: "1", reason: "page" }]);
    expect(before.rows).toEqual([row("/new-home", "/about")]);
    const after = plan([row("/new-home", "/about")], [takeOver], files("new-home/index.html"));
    expect(after.applied).toEqual(["1"]);
    expect(after.rows).toEqual([]);
  });

  it("a manual removal never waits", () => {
    const r = plan([row("/old", "/about")], [change("1", "/old", null)], served);
    expect(r.applied).toEqual(["1"]);
    expect(r.rows).toEqual([]);
  });

  it("a rename's removal and 301 wait together for the build that ships the move", () => {
    // A page moved /a → /b over a rule /b → /c: the take-over of /b and the
    // 301 /a → /b go live with the build that serves the page at /b.
    const live = [row("/b", "/about")];
    const changes = [
      change("rm", "/b", null, { automatic: true }),
      change("301", "/a", "/b", { automatic: true }),
    ];
    const oldBuild = plan(live, changes, files("a/index.html", "about/index.html"));
    expect(oldBuild.waiting.map((w) => w.id)).toEqual(["rm"]);
    // The 301 collapses through the live /b → /about and is shadowed by /a anyway.
    expect(oldBuild.applied).toEqual(["301"]);
    const newBuild = plan(live, changes, files("b/index.html", "about/index.html"));
    expect(newBuild.applied.sort()).toEqual(["301", "rm"]);
    expect(newBuild.rows).toEqual([row("/a", "/b")]);
  });

  it("refuses a table no host can serve, with the plan's message", () => {
    expect(() => plan([row("/a", "/b")], [change("1", "/b", "/a")], served)).toThrow(/loop/);
  });
});
