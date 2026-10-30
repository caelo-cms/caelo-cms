// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1256 — the write-time page-listing hint: cards that link most
 * published pages of one page type get a hint pointing at a page query;
 * a curated pick, the default page type and shared-list bindings stay
 * silent.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import { withFieldMarkupGuard } from "../tools/_markup-guard.js";
import {
  type ListingPage,
  type ListingSite,
  listingGroupsByPage,
  mayBeListing,
  pageListingHints,
  writtenLinks,
} from "../tools/_page-listing-guard.js";
import type { ToolContext, ToolDefinitionWithHandler } from "../tools/dispatch.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TYPE_PAGE = id(9001);
const TYPE_GUIDE = id(9002);

const guide = (i: number, status: ListingPage["status"] = "published"): ListingPage => ({
  id: id(100 + i),
  currentPath: `/guides/g${i}`,
  title: `Guide ${i}`,
  pageTypeId: TYPE_GUIDE,
  status,
});
const GUIDES = Array.from({ length: 6 }, (_, i) => guide(i));
const ORDINARY: ListingPage[] = ["/about", "/team", "/jobs", "/contact"].map((p, i) => ({
  id: id(300 + i),
  currentPath: p,
  title: p.slice(1),
  pageTypeId: TYPE_PAGE,
  status: "published",
}));
const SITE: ListingSite = {
  defaultPageTypeId: TYPE_PAGE,
  pageTypes: new Map([
    [TYPE_PAGE, { slug: "page", name: "Page" }],
    [TYPE_GUIDE, { slug: "guide", name: "Guide" }],
  ]),
  pages: [...GUIDES, guide(6, "draft"), ...ORDINARY],
};

/** Card values as build_page writes them: one value object per detached card. */
const cards = (pages: readonly ListingPage[], link: (p: ListingPage) => unknown) =>
  pages.map((p) => ({ title: p.title, href: link(p) }));

describe("writtenLinks", () => {
  it("reads paths, page references, link objects, list entries and href attributes", () => {
    expect(
      writtenLinks({
        a: "/guides/g0",
        b: `caelo:page/${id(101)}#top`,
        c: { href: "/guides/g2/" },
        d: [{ id: "x", node: "link", values: { label: "G3", link: { href: "/guides/g3" } } }],
        e: "<p><a href=\"/guides/g4\">four</a> and <a href='/guides/g5'>five</a></p>",
        f: "caelo:list/00000000-0000-4000-8000-000000000999",
        g: "Plain prose with / a slash",
        h: "https://other.test/x",
      }).sort(),
    ).toEqual(
      [
        "/guides/g0",
        `caelo:page/${id(101)}#top`,
        "/guides/g2/",
        "/guides/g3",
        "/guides/g4",
        "/guides/g5",
      ].sort(),
    );
  });
});

describe("pageListingHints (#1256)", () => {
  it("cards linking 4 of 6 guides name the missing ones and the page query", () => {
    const hints = pageListingHints([cards(GUIDES.slice(0, 4), (p) => p.currentPath)], SITE);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('4 of 6 published "Guide" pages, missing "Guide 4" (/guides/g4)');
    expect(hints[0]).toContain('"Guide 5" (/guides/g5)');
    expect(hints[0]).toContain('defaults:{page_type:"guide"}');
    expect(hints[0]).toContain("structure/manual-page-listing");
  });

  it("canonical page references and a complete set are recognised", () => {
    const hints = pageListingHints([cards(GUIDES, (p) => ({ href: `caelo:page/${p.id}` }))], SITE);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('all 6 published "Guide" pages');
  });

  it("a curated pick below half of the type stays silent", () => {
    expect(pageListingHints([cards(GUIDES.slice(0, 2), (p) => p.currentPath)], SITE)).toEqual([]);
    const many = {
      ...SITE,
      pages: [...SITE.pages, ...Array.from({ length: 10 }, (_, i) => guide(10 + i))],
    };
    expect(pageListingHints([cards(GUIDES.slice(0, 4), (p) => p.currentPath)], many)).toEqual([]);
  });

  it("links to pages of the default page type stay silent", () => {
    expect(pageListingHints([cards(ORDINARY, (p) => p.currentPath)], SITE)).toEqual([]);
  });

  it("links to draft pages do not count toward the listing", () => {
    const drafts = [7, 8, 9].map((i) => guide(i, "draft"));
    const site = { ...SITE, pages: [...SITE.pages, ...drafts] };
    expect(pageListingHints([cards(drafts, (p) => p.currentPath)], site)).toEqual([]);
  });

  it("a shared-list binding is no link", () => {
    const shared = [{ menu: "caelo:list/00000000-0000-4000-8000-000000000999" }];
    expect(mayBeListing([shared])).toBe(false);
    expect(pageListingHints([shared], SITE)).toEqual([]);
  });

  it("values written to different pages are judged per page", () => {
    const items = GUIDES.slice(0, 4).map((p, i) => ({
      pageId: id(i),
      values: { href: p.currentPath },
    }));
    const groups = listingGroupsByPage(
      items,
      (x) => x.pageId,
      (x) => x.values,
    );
    expect(groups).toHaveLength(4);
    expect(pageListingHints(groups, SITE)).toEqual([]);
  });
});

describe("withFieldMarkupGuard — page-listing hint", () => {
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  const AI: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-000000000a1a",
    actorKind: "ai",
    requestId: "issue-1256-unit",
  };
  const reads: string[] = [];
  const toolCtx = {
    registry,
    adapter: {
      runOperation: async (op: { name: string }) => {
        reads.push(op.name);
        if (op.name === "site_defaults.get") {
          return ok({ defaults: { defaultPageTypeId: TYPE_PAGE } });
        }
        if (op.name === "page_types.list") {
          return ok({
            pageTypes: [...SITE.pageTypes].map(([tid, t]) => ({ id: tid, ...t })),
          });
        }
        if (op.name === "pages.list") return ok({ pages: SITE.pages });
        if (op.name === "content_instances.list") return ok({ instances: [] });
        if (op.name === "modules.list") return ok({ modules: [] });
        return ok({});
      },
    } as unknown as DatabaseAdapter,
  } as ToolContext;
  const tool: ToolDefinitionWithHandler<{ cards: Record<string, unknown>[] }> = {
    name: "fake_build",
    description: "",
    schema: undefined as never,
    handler: async () => ({ ok: true, content: "built." }),
  };
  const guarded = withFieldMarkupGuard(
    tool,
    (i) => i.cards,
    undefined,
    (i) => [i.cards],
  );

  it("appends the hint when one call writes the cards of an overview", async () => {
    const r = await guarded.handler(
      AI,
      { cards: cards(GUIDES.slice(0, 5), (p) => p.currentPath) },
      toolCtx,
    );
    expect(r.content).toStartWith("built. 🎯 page-listing: these values link 5 of 6");
  });

  it("does not read the site for a write with fewer than three links", async () => {
    reads.length = 0;
    const r = await guarded.handler(AI, { cards: [{ title: "x", href: "/guides/g0" }] }, toolCtx);
    expect(r.content).toBe("built.");
    expect(reads).not.toContain("pages.list");
  });
});
