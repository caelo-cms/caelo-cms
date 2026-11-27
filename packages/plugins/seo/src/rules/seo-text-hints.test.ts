// SPDX-License-Identifier: MPL-2.0

/** #1757 — title and description width, stale pages, similar titles: hints, never findings. */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import { SEO_TEXT_HINT_RULE, titleSimilarity, widthHints } from "./seo-text-hints.js";
import { cutToWidth, SERP_LIMITS, TITLE_FONT_PX, textWidthPx } from "./serp-width.js";

const PAGE = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

const head = (title: string, description: string) => ({
  title: { value: title },
  metaDescription: { value: description },
});

describe("pixel widths", () => {
  it("measures by glyph, not by character count", () => {
    expect(textWidthPx("WWWW", TITLE_FONT_PX)).toBeGreaterThan(
      textWidthPx("iiii", TITLE_FONT_PX) * 3,
    );
    expect(textWidthPx("Über", TITLE_FONT_PX)).toBe(textWidthPx("Uber", TITLE_FONT_PX));
  });

  it("cuts at the last whole word that fits, as a result list does", () => {
    const long = "The complete guide to choosing a content management system for a growing team";
    const cut = cutToWidth(long, TITLE_FONT_PX, SERP_LIMITS.desktop.title);
    expect(cut.cut).toBe(true);
    expect(cut.text.endsWith(" …")).toBe(true);
    expect(textWidthPx(cut.text, TITLE_FONT_PX)).toBeLessThanOrEqual(SERP_LIMITS.desktop.title);
    expect(long.startsWith(cut.text.slice(0, -2))).toBe(true);
    expect(cutToWidth("Pricing", TITLE_FONT_PX, 580)).toEqual({ text: "Pricing", cut: false });
  });
});

describe("widthHints", () => {
  it("says when a title or description runs past a result's width, or is short", () => {
    expect(widthHints("/a", head("Pricing – Example", "x".repeat(60)))).toEqual([]);
    const long = widthHints("/a", head("W".repeat(40), "W".repeat(120)));
    expect(long[0]).toContain("<title> of /a");
    expect(long[1]).toContain("meta description of /a");
    expect(widthHints("/a", head("Pricing", "Prices."))[0]).toContain("short");
  });
});

describe("titleSimilarity", () => {
  it("compares the words of two titles", () => {
    expect(
      titleSimilarity("Pricing plans for teams", "Pricing plans for small teams"),
    ).toBeGreaterThan(0.6);
    expect(titleSimilarity("Pricing", "About us")).toBe(0);
    expect(titleSimilarity("", "x")).toBe(0);
  });
});

describe("the SEO text hint rule", () => {
  const ctx = (rows: Record<string, unknown>) =>
    ({
      cms: {
        call: async (op: string) => {
          if (op === "pages.list") return { pages: [rows.page] };
          if (op === "pages.search") return { pages: [rows.page, rows.other] };
          if (op === "pages_seo.get") return { resolved: rows.head };
          throw new Error(op);
        },
      },
    }) as unknown as PluginContextTier1;

  it("hints on width, a stale page and a similar title, for page_seo writes only", async () => {
    const hints = await SEO_TEXT_HINT_RULE.hints(
      ctx({
        page: {
          id: PAGE,
          title: "Pricing plans for teams",
          currentPath: "/pricing",
          updatedAt: "2024-01-01T00:00:00Z",
          status: "published",
        },
        other: {
          id: OTHER,
          title: "Pricing plans for small teams",
          currentPath: "/pricing-small",
          updatedAt: "2026-11-01T00:00:00Z",
          status: "published",
        },
        head: head(
          "W".repeat(40),
          "Plans and prices for every team size, billed monthly or yearly.",
        ),
      }),
      [{ kind: "page_seo", pageId: PAGE, seoTitle: "W".repeat(40) }],
    );
    expect(hints.some((h) => h.includes("<title> of /pricing"))).toBe(true);
    expect(hints.some((h) => h.includes("has not changed for"))).toBe(true);
    expect(hints.some((h) => h.includes("/pricing-small"))).toBe(true);
    expect(
      await SEO_TEXT_HINT_RULE.hints(ctx({}), [
        { kind: "media_alt", assetId: "a", alt: "The team" },
      ]),
    ).toEqual([]);
  });
});
