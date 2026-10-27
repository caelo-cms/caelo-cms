// SPDX-License-Identifier: MPL-2.0

/**
 * #587 — the redirect plan every provider serves: exact paths, the build
 * wins, chains collapse, loops and unservable rows fail loudly.
 */

import { describe, expect, it } from "bun:test";
import {
  buildRedirectPlan,
  formatRedirectsFile,
  parseRedirectsFile,
  type RedirectTableRow,
  redirectsToUnservedPaths,
} from "./redirect-plan.js";

const NO_FILES: ReadonlySet<string> = new Set();
const plan = (rows: RedirectTableRow[], servedFiles = NO_FILES, style = "directory" as const) =>
  buildRedirectPlan({ rows, pageUrlStyle: style, servedFiles });
const row = (fromPath: string, toPath: string, statusCode = 301): RedirectTableRow => ({
  fromPath,
  toPath,
  statusCode,
});

describe("parseRedirectsFile / formatRedirectsFile", () => {
  it("round-trips the generator's file", () => {
    const rows = [row("/a", "/b"), row("/gone", "/410", 410)];
    expect(parseRedirectsFile(formatRedirectsFile(rows))).toEqual(rows);
  });

  it("skips comments and blank lines, fails loudly on a malformed line", () => {
    expect(parseRedirectsFile("# x\n\n/a /b 302\n")).toEqual([row("/a", "/b", 302)]);
    expect(() => parseRedirectsFile("/a /b\n")).toThrow(/line 1 is not/);
    expect(() => parseRedirectsFile("/a /b x\n")).toThrow(/line 1 is not/);
  });
});

describe("buildRedirectPlan", () => {
  it("matches a page path with and without the slash, a file-like path and the root as written", () => {
    const p = plan([row("/old", "/new"), row("/old.html", "/new.pdf"), row("/", "/de", 302)]);
    expect(p.redirects.map((r) => r.matchPaths)).toEqual([["/old", "/old/"], ["/old.html"], ["/"]]);
  });

  it("points page targets at the directory URL in the directory style only", () => {
    const rows = [row("/a", "/b"), row("/c", "/d.pdf"), row("/e", "/f?x=1"), row("/g", "/h/")];
    expect(plan(rows).redirects.map((r) => r.location)).toEqual(["/b/", "/d.pdf", "/f?x=1", "/h/"]);
    expect(
      buildRedirectPlan({
        rows,
        pageUrlStyle: "no-extension",
        servedFiles: NO_FILES,
      }).redirects.map((r) => r.location),
    ).toEqual(["/b", "/d.pdf", "/f?x=1", "/h/"]);
  });

  it("keeps the visitor's query only when the target has no query or fragment", () => {
    const p = plan([row("/a", "/b"), row("/c", "/d?x"), row("/e", "/f#top")]);
    expect(p.redirects.map((r) => r.preserveQuery)).toEqual([true, false, false]);
  });

  it("normalises a stored trailing slash", () => {
    expect(plan([row("/old/", "/new")]).redirects[0]?.fromPath).toBe("/old");
  });

  it("leaves out rows whose from path a build file serves (#575)", () => {
    const p = plan(
      [row("/preise", "/de/preise"), row("/de/preise", "/preise"), row("/", "/de", 302)],
      new Set(["index.html", "preise/index.html"]),
    );
    expect(p.shadowedByBuild).toEqual(["/preise", "/"]);
    expect(p.redirects.map((r) => [r.fromPath, r.location])).toEqual([["/de/preise", "/preise/"]]);
    const noExt = buildRedirectPlan({
      rows: [row("/preise", "/x")],
      pageUrlStyle: "no-extension",
      servedFiles: new Set(["preise"]),
    });
    expect(noExt.redirects).toEqual([]);
  });

  it("collapses chains and combines the statuses", () => {
    const p = plan([
      row("/a", "/b", 301),
      row("/b", "/c", 308),
      row("/c", "/d", 308),
      row("/x", "/y", 302),
      row("/y", "/z", 301),
      row("/m", "/n", 307),
      row("/n", "/o", 308),
    ]);
    const byFrom = Object.fromEntries(p.redirects.map((r) => [r.fromPath, r]));
    expect([byFrom["/a"]?.location, byFrom["/a"]?.statusCode]).toEqual(["/d/", 301]);
    expect([byFrom["/b"]?.location, byFrom["/b"]?.statusCode]).toEqual(["/d/", 308]);
    expect([byFrom["/x"]?.location, byFrom["/x"]?.statusCode]).toEqual(["/z/", 302]);
    expect([byFrom["/m"]?.location, byFrom["/m"]?.statusCode]).toEqual(["/o/", 307]);
  });

  it("follows a chain through a target written with a trailing slash", () => {
    expect(plan([row("/a", "/b/"), row("/b", "/c")]).redirects[0]?.location).toBe("/c/");
  });

  it("stops a chain at a row the build shadows, at a gone row and at a target with a query", () => {
    const p = plan(
      [row("/a", "/b"), row("/b", "/c"), row("/g", "/gone"), row("/gone", "/410", 410)],
      new Set(["b/index.html"]),
    );
    expect(p.redirects.map((r) => [r.fromPath, r.location])).toEqual([
      ["/a", "/b/"],
      ["/g", "/gone/"],
    ]);
    expect(plan([row("/a", "/b?x=1"), row("/b", "/c")]).redirects[0]?.location).toBe("/b?x=1");
  });

  it("turns 410 rows into gone entries", () => {
    const p = plan([row("/gone", "/410", 410)]);
    expect(p.redirects).toEqual([]);
    expect(p.gone).toEqual([{ fromPath: "/gone", matchPaths: ["/gone", "/gone/"] }]);
  });

  it("fails loudly on a loop and names it", () => {
    expect(() => plan([row("/a", "/b"), row("/b", "/c"), row("/c", "/a")])).toThrow(
      /\/a → \/b → \/c → \/a form a loop/,
    );
    expect(() => plan([row("/a", "/a/")])).toThrow(/loop/);
  });

  it("fails loudly on rows no host can serve", () => {
    expect(() => plan([row("/a?x=1", "/b")])).toThrow(/'\?' or '#'.*'\/a'/);
    expect(() => plan([row("/a b", "/b")])).toThrow(/whitespace/);
    expect(() => plan([row("/a", "/b", 200)])).toThrow(/301, 302, 307, 308 or 410/);
    expect(() => plan([row("/a", "//evil.example")])).toThrow(/another host/);
  });

  it("dedupes identical spellings and refuses conflicting ones", () => {
    expect(plan([row("/a", "/b"), row("/a/", "/b")]).redirects).toHaveLength(1);
    expect(() => plan([row("/a", "/b"), row("/a/", "/c")])).toThrow(/two redirects answer "\/a"/);
  });

  it("keeps the rows' order (deterministic output)", () => {
    const rows = [row("/z", "/1"), row("/a", "/2")];
    expect(plan(rows).redirects.map((r) => r.fromPath)).toEqual(["/z", "/a"]);
    expect(plan(rows)).toEqual(plan([...rows]));
  });
});

describe("redirectsToUnservedPaths (#1157)", () => {
  const served = new Set(["index.html", "live/index.html", "doc.pdf"]);
  it("reports redirects whose target the build does not serve, nothing else", () => {
    const p = plan(
      [
        row("/a", "/live"),
        row("/b", "/draft-page"),
        row("/c", "/doc.pdf"),
        row("/d", "/missing.pdf"),
        row("/e", "/api/forms/x"),
        row("/f", "/live?ref=1"),
        row("/g", "/"),
      ],
      served,
    );
    expect(redirectsToUnservedPaths(p, served).map((r) => r.fromPath)).toEqual(["/b", "/d"]);
  });

  it("judges a chain by its final hop", () => {
    const p = plan([row("/x", "/y"), row("/y", "/live")], served);
    expect(redirectsToUnservedPaths(p, served)).toEqual([]);
  });
});
