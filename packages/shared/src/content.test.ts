// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  localeSchema,
  MODULE_HTML_MAX,
  moduleCreateSchema,
  pageCreateSchema,
  pageSetModulesSchema,
  pageUpdateSchema,
  slugSchema,
  templateBlocksSetSchema,
} from "./content.js";

describe("slugSchema", () => {
  it("accepts lowercase hyphenated slugs", () => {
    expect(slugSchema.safeParse("hero").success).toBe(true);
    expect(slugSchema.safeParse("hero-banner").success).toBe(true);
    expect(slugSchema.safeParse("a").success).toBe(true);
    expect(slugSchema.safeParse("a1-b2").success).toBe(true);
  });

  it("rejects leading/trailing hyphens, uppercase, and empties", () => {
    expect(slugSchema.safeParse("-hero").success).toBe(false);
    expect(slugSchema.safeParse("hero-").success).toBe(false);
    expect(slugSchema.safeParse("Hero").success).toBe(false);
    expect(slugSchema.safeParse("").success).toBe(false);
    expect(slugSchema.safeParse("a".repeat(65)).success).toBe(false);
  });
});

describe("localeSchema", () => {
  it("accepts language and language-region", () => {
    expect(localeSchema.safeParse("en").success).toBe(true);
    expect(localeSchema.safeParse("de").success).toBe(true);
    expect(localeSchema.safeParse("de-AT").success).toBe(true);
  });

  it("rejects malformed locales", () => {
    expect(localeSchema.safeParse("EN").success).toBe(false);
    expect(localeSchema.safeParse("en-us").success).toBe(false);
    expect(localeSchema.safeParse("eng").success).toBe(false);
    expect(localeSchema.safeParse("").success).toBe(false);
  });
});

describe("moduleCreateSchema", () => {
  it("accepts a minimal module", () => {
    const r = moduleCreateSchema.safeParse({
      slug: "hero",
      displayName: "Hero",
      html: "<p>hi</p>",
    });
    expect(r.success).toBe(true);
  });

  it("rejects oversized html", () => {
    const huge = "x".repeat(MODULE_HTML_MAX + 1);
    const r = moduleCreateSchema.safeParse({
      slug: "hero",
      displayName: "Hero",
      html: huge,
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const r = moduleCreateSchema.safeParse({
      slug: "hero",
      displayName: "Hero",
      html: "<p>hi</p>",
      unexpected: "noop",
    });
    expect(r.success).toBe(false);
  });
});

describe("pageCreateSchema (no raw HTML invariant)", () => {
  it("accepts a structured page payload", () => {
    const r = pageCreateSchema.safeParse({
      slug: "home",
      title: "Home",
      templateId: "11111111-1111-4111-8111-111111111111",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.locale).toBe("en");
    expect(r.data.status).toBe("draft");
  });

  it("rejects an `html` field — §3.1 invariant in code", () => {
    const r = pageCreateSchema.safeParse({
      slug: "home",
      title: "Home",
      templateId: "11111111-1111-4111-8111-111111111111",
      html: "<p>raw</p>",
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const unrecognized = r.error.issues.find((i) => i.code === "unrecognized_keys");
    expect(unrecognized).toBeTruthy();
    expect((unrecognized as { keys?: string[] }).keys).toContain("html");
  });

  it("rejects any unrecognised key", () => {
    const r = pageCreateSchema.safeParse({
      slug: "home",
      title: "Home",
      templateId: "11111111-1111-4111-8111-111111111111",
      bodyMarkdown: "# raw",
    });
    expect(r.success).toBe(false);
  });
});

describe("pageUpdateSchema (no raw HTML invariant)", () => {
  it("rejects an `html` field on update too", () => {
    const r = pageUpdateSchema.safeParse({
      pageId: "11111111-1111-4111-8111-111111111111",
      html: "<p>bad</p>",
    });
    expect(r.success).toBe(false);
  });
});

describe("pageSetModulesSchema", () => {
  it("accepts a structured composition", () => {
    const r = pageSetModulesSchema.safeParse({
      pageId: "11111111-1111-4111-8111-111111111111",
      blocks: [{ blockName: "content", moduleIds: ["22222222-2222-4222-8222-222222222222"] }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects raw HTML in blocks", () => {
    const r = pageSetModulesSchema.safeParse({
      pageId: "11111111-1111-4111-8111-111111111111",
      blocks: [{ blockName: "content", html: "<p>x</p>" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("templateBlocksSetSchema", () => {
  it("accepts a list of slot definitions", () => {
    const r = templateBlocksSetSchema.safeParse({
      templateId: "11111111-1111-4111-8111-111111111111",
      blocks: [
        { name: "header", displayName: "Header", position: 0 },
        { name: "content", displayName: "Content", position: 1 },
      ],
    });
    expect(r.success).toBe(true);
  });
});
