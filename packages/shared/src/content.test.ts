// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  localeSchema,
  MODULE_HTML_MAX,
  moduleCreateSchema,
  moduleUpdateSchema,
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

  // issue #432 — CDATA wrappers stored verbatim broke rendering and sent the
  // AI into a ~20-loop visual repair spiral; the write boundary now rejects
  // them with an actionable message.
  it("rejects XML CDATA wrappers in css and js, with an actionable message", () => {
    const base = { slug: "site-header", displayName: "Site header", html: "<header></header>" };
    const css = moduleCreateSchema.safeParse({
      ...base,
      css: "/*<![CDATA[*/ .x { color: red } /*]]>*/",
    });
    expect(css.success).toBe(false);
    if (!css.success) {
      expect(css.error.issues.map((i) => i.message).join(" ")).toContain("CDATA");
    }
    const js = moduleCreateSchema.safeParse({
      ...base,
      js: "//<![CDATA[\nconsole.log('hi');\n//]]>",
    });
    expect(js.success).toBe(false);
  });

  it("accepts plain css/js (and js merely mentioning ']]>' in a string)", () => {
    const base = { slug: "site-header", displayName: "Site header", html: "<header></header>" };
    expect(
      moduleCreateSchema.safeParse({ ...base, css: ".x { color: red }", js: "console.log(1);" })
        .success,
    ).toBe(true);
    // Only the OPENING marker is the corruption signature; a bare "]]>"
    // inside a string literal is legitimate (e.g. code emitting XML).
    expect(moduleCreateSchema.safeParse({ ...base, js: 'xml += "]]>";' }).success).toBe(true);
  });

  it("rejects CDATA on the update path too (edit_module / edit_content funnel)", () => {
    const r = moduleUpdateSchema.safeParse({
      moduleId: "8c2f2f2a-0000-4000-8000-000000000432",
      css: "/*<![CDATA[*/ .x{} /*]]>*/",
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
    // status is intentionally OPTIONAL (no schema default): pages.create
    // resolves it at write time — published on a bootstrap site, else draft.
    // Omitting it here leaves it undefined for the handler to resolve.
    expect(r.data.status).toBeUndefined();
  });

  it("preserves an explicit status (the schema never overrides it)", () => {
    const r = pageCreateSchema.safeParse({
      slug: "home",
      title: "Home",
      templateId: "11111111-1111-4111-8111-111111111111",
      status: "published",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.status).toBe("published");
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
