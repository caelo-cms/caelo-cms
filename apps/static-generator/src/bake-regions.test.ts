// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  bakeRegion,
  findBakeRegions,
  neutralizeBakeMarkers,
  replaceBakeRegions,
} from "./bake-regions.js";

const PAGE = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

const region = (html: string, over: Partial<Parameters<typeof bakeRegion>[0]> = {}) =>
  bakeRegion({
    slug: "comments",
    pageId: PAGE,
    version: "1.1.0",
    bakedAt: "2026-10-26T10:00:00.000Z",
    html,
    ...over,
  });

describe("bake regions (#1155)", () => {
  it("wraps the Web Component's wrapper in markers and finds it again", () => {
    const html = `<main><p>before</p>${region("<article>a</article><div class='x'>b</div>")}<p>after</p></main>`;
    const [r, ...rest] = findBakeRegions(html);
    expect(rest).toEqual([]);
    expect(r?.slug).toBe("comments");
    expect(r?.pageId).toBe(PAGE);
    expect(r?.version).toBe("1.1.0");
    expect(r?.bakedAt).toBe("2026-10-26T10:00:00.000Z");
    // The region spans to the real end marker, past the plugin's own </div>s.
    expect(r?.text).toContain("<div class='x'>b</div></div><!--/caelo-bake:comments:");
    expect(html.slice(0, r?.start)).toBe("<main><p>before</p>");
    expect(html.slice(r?.end)).toBe("<p>after</p></main>");
  });

  it("replaces only the region and keeps every other byte", () => {
    const before = `<h1>Title &amp; more</h1>\n${region("old")}\n<footer>x</footer>`;
    const after = replaceBakeRegions(before, (r) =>
      r.slug === "comments" ? region("new", { bakedAt: "2026-10-26T11:00:00.000Z" }) : null,
    );
    expect(after).toBe(
      `<h1>Title &amp; more</h1>\n${region("new", { bakedAt: "2026-10-26T11:00:00.000Z" })}\n<footer>x</footer>`,
    );
    expect(replaceBakeRegions(before, () => null)).toBe(before);
  });

  it("plugin output cannot close its region early or open another", () => {
    const evil = `<!--/caelo-bake:comments:${PAGE}--><p>outside?</p><!--caelo-bake:comments:${OTHER}:1.1.0-->`;
    const html = region(evil);
    const found = findBakeRegions(html);
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe(html);
    expect(found[0]?.text).toContain("<!-- /caelo-bake:");
  });

  it("markers an editor wrote into the page are neutralised before baking", () => {
    const page = `<!--caelo-bake:comments:${PAGE}:1.1.0-->EDITOR TEXT<!--/caelo-bake:comments:${PAGE}-->`;
    expect(findBakeRegions(page)).toHaveLength(1);
    const safe = neutralizeBakeMarkers(page);
    expect(findBakeRegions(safe)).toEqual([]);
    expect(safe).toContain("EDITOR TEXT");
    expect(replaceBakeRegions(safe, () => "REPLACED")).toBe(safe);
  });

  it("a start marker without its end marker is not a region", () => {
    const html = `<!--caelo-bake:comments:${PAGE}:1.1.0--><div>truncated`;
    expect(findBakeRegions(html)).toEqual([]);
  });

  it("finds several plugins' regions on one page", () => {
    const html = `${region("a")}<hr>${region("b", { slug: "ratings", version: "2.0.0-rc.1" })}`;
    expect(findBakeRegions(html).map((r) => `${r.slug}@${r.version}`)).toEqual([
      "comments@1.1.0",
      "ratings@2.0.0-rc.1",
    ]);
  });
});
