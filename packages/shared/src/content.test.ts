// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  MODULE_HTML_MAX,
  moduleCreateSchema,
  moduleUpdateSchema,
  pageCreateSchema,
  pageSetModulesSchema,
  pageUpdateSchema,
  slugSchema,
  templateBlocksSetSchema,
  templateCreateSchema,
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

// CLAUDE.md §1A / issue #417 — repeating content is a list field, never
// numbered scalars. Threshold is 3: a pair (col1/col2) is a legitimate
// layout split; three-or-more numbered siblings is a list.
describe("moduleFields numbered-scalar fanout guard (§1A)", () => {
  const mod = (fields: unknown) =>
    moduleCreateSchema.safeParse({
      slug: "cards",
      displayName: "Cards",
      html: "<div></div>",
      fields,
    });
  const text = (name: string) => ({ name, kind: "text", label: name });

  it("rejects a bare base + numbered siblings (label, label2, label3)", () => {
    const r = mod([text("label"), text("label2"), text("label3")]);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues[0]?.message ?? "";
      expect(msg).toContain("numbered-scalar fanout");
      expect(msg).toContain('"label", "label2", "label3"');
      // AI-actionable: the error names every list-kind fix.
      expect(msg).toContain('kind "list"');
      expect(msg).toContain('listType "texts"');
      expect(msg).toContain('"links"');
      expect(msg).toContain("module-list");
      expect(msg).toContain("§1A");
    }
  });

  it("rejects underscore-separated runs (quote_1..quote_3) and mixed separators", () => {
    expect(mod([text("quote_1"), text("quote_2"), text("quote_3")]).success).toBe(false);
    expect(mod([text("logo1"), text("logo_2"), text("logo_3")]).success).toBe(false);
  });

  it("rejects fanout on moduleUpdateSchema too (same shared fields array)", () => {
    const r = moduleUpdateSchema.safeParse({
      moduleId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      fields: [text("card1"), text("card2"), text("card3")],
    });
    expect(r.success).toBe(false);
  });

  it("allows a two-field split (col1/col2) — threshold is 3", () => {
    expect(mod([text("col1"), text("col2")]).success).toBe(true);
    expect(mod([text("label"), text("label2")]).success).toBe(true);
    expect(mod([text("address_line1"), text("address_line2")]).success).toBe(true);
  });

  it("allows unrelated numbered fields that never form a run of 3", () => {
    expect(mod([text("hero_title"), text("cta_2024"), text("step_1")]).success).toBe(true);
    // Same suffix, different bases — no shared run.
    expect(mod([text("left_col1"), text("right_col1"), text("mid_col1")]).success).toBe(true);
  });

  it("scopes to scalar kinds — numbered list fields are a modelling question, not fanout", () => {
    const linkList = (name: string) => ({ name, kind: "list", listType: "links", label: name });
    expect(mod([linkList("links1"), linkList("links2"), linkList("links3")]).success).toBe(true);
  });
});

// Epic #1107 — the `list` field kind (docs/lists.md §7): the static
// schema checks the binding's shape; fitting the type is the op's job.
describe("moduleFields list kind", () => {
  const mod = (fields: unknown) =>
    moduleCreateSchema.safeParse({ slug: "m", displayName: "M", html: "<div></div>", fields });
  const LIST = "caelo:list/00000000-0000-4000-8000-000000000101";
  const messages = (r: ReturnType<typeof mod>) =>
    r.success ? [] : r.error.issues.map((i) => i.message);

  it("accepts every binding", () => {
    const ok = mod([
      {
        name: "bullets",
        label: "B",
        kind: "list",
        listType: "texts",
        default: [{ node: "text", values: { text: "x" } }],
      },
      { name: "menu", label: "M", kind: "list", listType: "menu", bind: "shared", list: LIST },
      {
        name: "footer",
        label: "F",
        kind: "list",
        listType: "links",
        bind: "shared",
        default: LIST,
      },
      {
        name: "latest",
        label: "L",
        kind: "list",
        listType: "links",
        bind: "source",
        source: {
          kind: "query",
          editable: ["limit"],
          defaults: { page_type: "news", order: "published_desc", limit: 3 },
        },
      },
      {
        name: "crumbs",
        label: "C",
        kind: "list",
        listType: "links",
        bind: "source",
        source: { kind: "system", name: "breadcrumbs" },
      },
    ]);
    expect(ok.success).toBe(true);
  });

  it("refuses bindings whose parts do not fit together, naming the fix", () => {
    const r = mod([
      { name: "a", label: "A", kind: "list", listType: "menu", bind: "source" },
      { name: "b", label: "B", kind: "list", listType: "menu", list: LIST },
      { name: "c", label: "C", kind: "list", listType: "menu", bind: "shared", default: [] },
      { name: "d", label: "D", kind: "list", listType: "texts", default: LIST },
    ]);
    expect(messages(r)).toEqual([
      'list field "a": bind "source" needs a source (query, system or plugin).',
      'list field "b": list is only allowed with bind "shared" — a local list stores its entries in the placement.',
      'list field "c": a shared default is caelo:list/<id> — create the list with upsert_lists_many first.',
      'list field "d": a local default is an array of entries, not a list reference.',
    ]);
  });

  it("refuses the removed text-list / link-list kinds", () => {
    expect(mod([{ name: "t", label: "T", kind: "text-list" }]).success).toBe(false);
    expect(mod([{ name: "l", label: "L", kind: "link-list" }]).success).toBe(false);
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

describe("corrupted code payloads are refused at the boundary (PR #1121 e2e)", () => {
  const base = { slug: "footer", displayName: "Footer", html: "<footer>x</footer>" };
  it("refuses JSON-encoded html and css with the fix in the message", () => {
    const html = moduleCreateSchema.safeParse({
      ...base,
      html: JSON.stringify('<footer class="x">{{#links}}{{label}}{{/links}}</footer>'),
    });
    expect(html.success).toBe(false);
    expect(html.error?.issues[0]?.message).toContain("JSON-encoded");
    const css = moduleCreateSchema.safeParse({
      ...base,
      css: JSON.stringify(".x { color: red; }"),
    });
    expect(css.success).toBe(false);
  });
  it("refuses HTML-escaped template markup", () => {
    const r = templateCreateSchema.safeParse({
      slug: "page",
      displayName: "Page",
      html: '&lt;div&gt;&lt;caelo-slot name="content"&gt;&lt;/caelo-slot&gt;&lt;/div&gt;',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain("HTML-escaped");
  });
  it("keeps legitimate markup: entities inside real tags, a quote-led text node", () => {
    expect(
      moduleCreateSchema.safeParse({ ...base, html: "<pre>&lt;div&gt; is a tag</pre>" }).success,
    ).toBe(true);
    expect(moduleCreateSchema.safeParse({ ...base, html: '"Quoted" <em>text</em>' }).success).toBe(
      true,
    );
  });
});
