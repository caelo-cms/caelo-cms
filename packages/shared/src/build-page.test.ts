// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #299 — input-schema tests for the bulk build path. The contract
 * under test: invalid entries fail LOUD with the failing element's index
 * in the Zod path (so the dispatcher's error names `modules[i]` /
 * `instances[i]`), and the mode gates (page: pageId XOR slug+title;
 * module: moduleId XOR displayName+html) reject ambiguous calls.
 */

import { describe, expect, it } from "bun:test";
import {
  buildPageContentSchema,
  buildPageInputSchema,
  contentInstancesCreateManySchema,
  pageModuleContentSetManySchema,
} from "./build-page.js";

// Zod 4's .uuid() enforces RFC 4122 version/variant bits — use real
// v4-shaped constants, not sequential zero-padded strings.
const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

const mintModule = {
  blockName: "content",
  displayName: "Hero",
  html: "<section><h1>{{hero_title}}</h1></section>",
  description: "Homepage hero",
  kind: "hero",
  fields: [{ name: "hero_title", kind: "text", label: "Hero title" }],
} as const;

describe("buildPageInputSchema — page target modes", () => {
  it("accepts create mode (slug + title) with defaults applied downstream", () => {
    const r = buildPageInputSchema.safeParse({
      page: { slug: "pricing", title: "Pricing" },
      modules: [mintModule],
    });
    expect(r.success).toBe(true);
  });

  it("accepts existing mode (pageId only)", () => {
    const r = buildPageInputSchema.safeParse({
      page: { pageId: UUID },
      modules: [{ blockName: "content", moduleId: UUID2 }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects pageId mixed with create keys, naming the offending keys", () => {
    const r = buildPageInputSchema.safeParse({
      page: { pageId: UUID, slug: "pricing", title: "Pricing" },
      modules: [mintModule],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues[0]!;
    expect(issue.message).toContain("pageId targets an EXISTING page");
    expect(issue.message).toContain("slug");
    expect(issue.message).toContain("title");
  });

  it("rejects a page target with neither pageId nor slug+title", () => {
    const r = buildPageInputSchema.safeParse({
      page: { slug: "pricing" },
      modules: [mintModule],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0]!.message).toContain("`slug` + `title`");
  });
});

describe("buildPageInputSchema — module entry modes name the failing index", () => {
  it("rejects a mixed entry (moduleId + authoring keys) with the array index in the path", () => {
    const r = buildPageInputSchema.safeParse({
      page: { slug: "pricing", title: "Pricing" },
      modules: [
        mintModule,
        { blockName: "content", moduleId: UUID2, html: "<p>x</p>", displayName: "Dup" },
      ],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues.find((i) => i.message.includes("moduleId places an EXISTING"));
    expect(issue).toBeDefined();
    // The failing element's index rides in the Zod path → the dispatcher
    // error names modules[1], not just "invalid input".
    expect(issue!.path[0]).toBe("modules");
    expect(issue!.path[1]).toBe(1);
    expect(issue!.message).toContain("html");
    expect(issue!.message).toContain("displayName");
  });

  it("rejects an entry with neither moduleId nor displayName+html, at its index", () => {
    const r = buildPageInputSchema.safeParse({
      page: { slug: "pricing", title: "Pricing" },
      modules: [mintModule, mintModule, { blockName: "content" }],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues.find((i) => i.message.includes("Pass either `moduleId`"));
    expect(issue).toBeDefined();
    expect(issue!.path[0]).toBe("modules");
    expect(issue!.path[1]).toBe(2);
  });

  it("list-shaped field kinds are representable (CLAUDE.md §1A — no numbered scalars)", () => {
    const r = buildPageInputSchema.safeParse({
      page: { slug: "p", title: "P" },
      modules: [
        {
          blockName: "content",
          displayName: "Nav",
          html: "<nav>{{#nav_links}}<a href='{{href}}'>{{label}}</a>{{/nav_links}}</nav>",
          fields: [
            { name: "nav_links", kind: "link-list", label: "Nav links" },
            { name: "tags", kind: "text-list", label: "Tags", min: 0, max: 12 },
          ],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("caps the batch at 40 modules", () => {
    const r = buildPageInputSchema.safeParse({
      page: { slug: "p", title: "P" },
      modules: Array.from({ length: 41 }, () => mintModule),
    });
    expect(r.success).toBe(false);
  });
});

describe("buildPageContentSchema — the three sources", () => {
  it("inline requires values", () => {
    expect(buildPageContentSchema.safeParse({ source: "inline" }).success).toBe(false);
    expect(
      buildPageContentSchema.safeParse({ source: "inline", values: { hero_title: "x" } }).success,
    ).toBe(true);
  });

  it("shared requires purpose and defaults syncMode to synced", () => {
    const missing = buildPageContentSchema.safeParse({ source: "shared", values: {} });
    expect(missing.success).toBe(false);
    const r = buildPageContentSchema.safeParse({
      source: "shared",
      purpose: "Footer CTA shared across product pages",
      values: { cta_label: "Go" },
    });
    expect(r.success).toBe(true);
    if (!r.success || r.data.source !== "shared") return;
    expect(r.data.syncMode).toBe("synced");
  });

  it("existing requires contentInstanceId and defaults syncMode to synced", () => {
    const r = buildPageContentSchema.safeParse({ source: "existing", contentInstanceId: UUID });
    expect(r.success).toBe(true);
    if (!r.success || r.data.source !== "existing") return;
    expect(r.data.syncMode).toBe("synced");
  });

  it("rejects cross-variant keys (purpose on inline)", () => {
    const r = buildPageContentSchema.safeParse({
      source: "inline",
      values: {},
      purpose: "nope",
    });
    expect(r.success).toBe(false);
  });
});

describe("contentInstancesCreateManySchema", () => {
  it("accepts a batch of singular-shaped items", () => {
    const r = contentInstancesCreateManySchema.safeParse({
      instances: [
        { moduleId: UUID, values: { a: 1 } },
        { moduleId: UUID2, purpose: "shared cta", values: {} },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("names the failing item index in the Zod path", () => {
    const r = contentInstancesCreateManySchema.safeParse({
      instances: [{ moduleId: UUID }, { moduleId: "not-a-uuid" }],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues[0]!;
    expect(issue.path[0]).toBe("instances");
    expect(issue.path[1]).toBe(1);
    expect(issue.path[2]).toBe("moduleId");
  });

  it("rejects an empty batch", () => {
    expect(contentInstancesCreateManySchema.safeParse({ instances: [] }).success).toBe(false);
  });
});

describe("pageModuleContentSetManySchema", () => {
  it("accepts multi-page batches", () => {
    const r = pageModuleContentSetManySchema.safeParse({
      items: [
        { pageId: UUID, blockName: "content", position: 0, contentValues: { t: "x" } },
        { pageId: UUID2, blockName: "content", position: 3, contentValues: {} },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("names the failing item index + field in the Zod path", () => {
    const r = pageModuleContentSetManySchema.safeParse({
      items: [
        { pageId: UUID, blockName: "content", position: 0, contentValues: {} },
        { pageId: UUID, blockName: "content", position: -1, contentValues: {} },
      ],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues[0]!;
    expect(issue.path[0]).toBe("items");
    expect(issue.path[1]).toBe(1);
    expect(issue.path[2]).toBe("position");
  });
});
