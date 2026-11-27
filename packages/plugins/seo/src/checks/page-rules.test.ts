// SPDX-License-Identifier: MPL-2.0

/**
 * #1757 — every objective page rule with a page that breaks it and one
 * that does not, and each finding carries the tool that fixes it.
 */

import { describe, expect, it } from "bun:test";
import type {
  PluginAuditHeading,
  PluginAuditImage,
  PluginAuditPageFacts,
  PluginContextTier1,
} from "@caelo-cms/plugin-sdk";
import { groupAllows } from "../crawlers/robots-match.js";
import { seoAudit } from "./index.js";
import {
  headingFindings,
  imageFindings,
  isFileNameAlt,
  isPlaceholderText,
  linkTextFindings,
  pageFindings,
  placeholderFindings,
  shareImageFindings,
} from "./page-rules.js";
import { PAGE_AUDIT_RULE } from "./pages.js";

const PAGE = "00000000-0000-4000-8000-000000000001";
const place = { moduleId: null, listItem: null, pluginSlug: null };

function facts(over: Partial<PluginAuditPageFacts> = {}): PluginAuditPageFacts {
  return {
    pageId: PAGE,
    path: "/guide",
    lang: "en",
    title: "The guide",
    metaDescription: "What the guide covers.",
    canonical: null,
    robots: "max-image-preview:large",
    ogLocale: null,
    ogLocaleAlternates: [],
    alternates: [],
    sitemapAlternates: null,
    links: [],
    texts: [],
    headings: [{ level: 1, text: "The guide", ...place }],
    images: [],
    jsonLd: [],
    socialMeta: [
      { key: "og:image", attribute: "property", content: "https://x.example/_assets/a.0123.jpg" },
    ],
    truncated: false,
    truncatedFacts: [],
    ...over,
  };
}

const h = (level: PluginAuditHeading["level"], text: string): PluginAuditHeading => ({
  level,
  text,
  ...place,
});

const img = (over: Partial<PluginAuditImage>): PluginAuditImage => ({
  src: { href: "/_assets/team.0123abcd.jpg", path: "/_assets/team.0123abcd.jpg" },
  media: { ref: "team", variant: "orig" },
  alt: "The team at the office",
  width: 800,
  height: 600,
  decorative: false,
  ...place,
  ...over,
});

const link = (text: string, href = "/pricing") => ({
  href,
  path: href,
  hreflang: null,
  text,
  ...place,
});

const rules = (found: { rule: string }[]) => found.map((f) => f.rule);

describe("a clean page", () => {
  it("has no finding", () => {
    expect(
      pageFindings(
        facts({
          headings: [h(1, "Guide"), h(2, "Setup"), h(3, "Details"), h(2, "Next")],
          images: [img({}), img({ alt: "", decorative: true })],
          links: [link("Read the pricing guide")],
          texts: [
            { text: "Welcome.", moduleId: null, listItem: null, pluginSlug: null, source: "text" },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe("headings", () => {
  it("wants exactly one H1", () => {
    expect(rules(headingFindings(facts({ headings: [h(2, "A")] })))).toEqual(["h1-count"]);
    expect(rules(headingFindings(facts({ headings: [h(1, "A"), h(1, "B")] })))).toEqual([
      "h1-count",
    ]);
    // A cut heading list proves two H1s, never none.
    expect(headingFindings(facts({ headings: [h(2, "A")], truncatedFacts: ["headings"] }))).toEqual(
      [],
    );
  });

  it("flags a skipped level and an empty heading", () => {
    const found = headingFindings(facts({ headings: [h(1, "A"), h(2, "B"), h(4, "C"), h(2, "")] }));
    expect(rules(found)).toEqual(["heading-level-skipped", "heading-empty"]);
    expect(found[0]?.message).toContain("h4");
    expect(found[0]?.fix?.tool).toBe("update_modules_many");
    // Going back up any number of levels is fine.
    expect(
      headingFindings(facts({ headings: [h(1, "A"), h(2, "B"), h(3, "C"), h(2, "D")] })),
    ).toEqual([]);
  });
});

describe("images", () => {
  it("flags an image without alt unless it is decorative", () => {
    expect(rules(imageFindings(facts({ images: [img({ alt: null })] })))).toEqual([
      "image-alt-missing",
    ]);
    expect(imageFindings(facts({ images: [img({ alt: null, decorative: true })] }))).toEqual([]);
    const many = imageFindings(
      facts({ images: Array.from({ length: 5 }, () => img({ alt: null })) }),
    );
    expect(many).toHaveLength(4);
    expect(many.at(-1)?.message).toContain("2 more");
  });

  it("flags an alt that is a file name", () => {
    expect(rules(imageFindings(facts({ images: [img({ alt: "IMG_0042.JPG" })] })))).toEqual([
      "image-alt-filename",
    ]);
    for (const alt of ["DSC01234", "screenshot-2026", "photo.webp", "team.png"]) {
      expect(isFileNameAlt(alt)).toBe(true);
    }
    for (const alt of [
      "Our team in 2026",
      "A red bicycle",
      "state-of-the-art lab",
      "Image of a dog",
    ]) {
      expect(isFileNameAlt(alt)).toBe(false);
    }
  });
});

describe("link texts", () => {
  it("flags empty and generic link texts", () => {
    const found = linkTextFindings(
      facts({ links: [link(""), link("Click here"), link("mehr »"), link("Pricing plans")] }),
    );
    expect(rules(found)).toEqual(["link-text-empty", "link-text-generic", "link-text-generic"]);
    expect(linkTextFindings(facts({ links: [link("Read the setup guide")] }))).toEqual([]);
  });
});

describe("placeholder text", () => {
  it("flags lorem ipsum and notes for the writer, not code or real words", () => {
    expect(isPlaceholderText("Lorem ipsum dolor sit amet")).toBe(true);
    expect(isPlaceholderText("TODO: write the intro")).toBe(true);
    expect(isPlaceholderText("Price [TBD]")).toBe(true);
    expect(isPlaceholderText("Our todo app keeps lists")).toBe(false);
    expect(isPlaceholderText("TODOs are tasks")).toBe(false);
    const found = placeholderFindings(
      facts({
        title: "Lorem ipsum",
        texts: [
          { text: "TODO", moduleId: null, listItem: null, pluginSlug: null, source: "text" },
          {
            text: "// TODO: x",
            moduleId: null,
            listItem: null,
            pluginSlug: null,
            source: "literal",
          },
        ],
      }),
    );
    expect(found).toHaveLength(2);
    expect(found[0]?.message).toContain("<title>");
  });
});

describe("share image", () => {
  it("wants a JPEG or PNG og:image on an indexable page", () => {
    expect(rules(shareImageFindings(facts({ socialMeta: [] })))).toEqual(["share-image-missing"]);
    const webp = shareImageFindings(
      facts({
        socialMeta: [
          { key: "og:image", attribute: "property", content: "/_assets/a/webp-1200.0123.webp" },
        ],
      }),
    );
    expect(rules(webp)).toEqual(["share-image-format"]);
    expect(webp[0]?.message).toContain("LinkedIn");
    expect(shareImageFindings(facts())).toEqual([]);
    // A noindex page is not shared from search.
    expect(shareImageFindings(facts({ socialMeta: [], robots: "noindex, follow" }))).toEqual([]);
  });
});

describe("noindex pages robots.txt hides", () => {
  const ctxWith = (robotsRules: unknown) =>
    ({ cms: { call: async () => ({ robotsRules }) } }) as unknown as PluginContextTier1;

  it("flags a noindex page whose path search engines may not fetch", async () => {
    const page = facts({ path: "/de/suche", robots: "noindex" });
    const blocked = await PAGE_AUDIT_RULE.facts?.(
      ctxWith([{ userAgents: ["*"], allow: [], disallow: ["/de/suche"] }]),
      { facts: [page], auditRunId: undefined },
    );
    expect(rules(blocked ?? [])).toContain("noindex-blocked");
    const open = await PAGE_AUDIT_RULE.facts?.(ctxWith([]), {
      facts: [page],
      auditRunId: undefined,
    });
    expect(rules(open ?? [])).not.toContain("noindex-blocked");
  });

  it("reads groups as RFC 9309 does", () => {
    const g = (allow: string[], disallow: string[]) => ({ userAgents: ["*"], allow, disallow });
    expect(groupAllows(g([], ["/"]), "/x")).toBe(false);
    expect(groupAllows(g(["/blog/"], ["/"]), "/blog/a")).toBe(true);
    expect(groupAllows(g(["/a"], ["/a"]), "/a")).toBe(true);
    expect(groupAllows(g([], ["/*.pdf$"]), "/x.pdf")).toBe(false);
    expect(groupAllows(g([], ["/*.pdf$"]), "/x.pdf/y")).toBe(true);
    expect(groupAllows(g([], ["/se"]), "/search")).toBe(false);
    expect(groupAllows(undefined, "/x")).toBe(true);
  });
});

describe("through the audit operation", () => {
  it("asks for facts and files the page findings of a batch", async () => {
    const ctx = {
      cms: { call: async () => ({ robotsRules: [] }) },
    } as unknown as PluginContextTier1;
    const first = await seoAudit(ctx, { pages: [{ pageId: PAGE, path: "/guide" }] });
    expect(first.factBatches).toEqual([[PAGE]]);
    expect(first.batchPages).toBe("own");
    const batch = await seoAudit(ctx, {
      pages: [{ pageId: PAGE, path: "/guide" }],
      facts: [facts({ headings: [] })],
      batchPages: "own",
      auditRunId: "00000000-0000-4000-8000-0000000000aa",
    });
    expect(rules(batch.findings)).toEqual(["h1-count"]);
    for (const f of batch.findings) expect(f.fix?.tool).toBeTruthy();
  });
});
