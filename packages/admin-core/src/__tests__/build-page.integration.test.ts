// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #299 — `pages.build_page` + the bulk content ops.
 *
 * Covers the §11 contract: ONE call assembles a page (create + N modules
 * + content instances + placements) in one transaction; any mid-batch
 * validation failure aborts the WHOLE call (page, modules, instances all
 * rolled back — partial failure impossible) with an error naming the
 * failing module index (and field, for value-shape problems). Plus the
 * same all-or-nothing contract for `content_instances.create_many` and
 * `page_module_content.set_many`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "build-page-test",
};

const TS = Date.now().toString(36);
const TPL_SLUG = `i299-tpl-${TS}`;
const PAGE_SLUG = `i299-page-${TS}`;
const PAGE_SLUG_ABORT = `i299-abort-${TS}`;
const PAGE_SLUG_FIELD = `i299-field-${TS}`;
const SHARED_CI_SLUG = `i299-shared-cta-${TS}`;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`i299-%-${TS}`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`i299-%-${TS}`}`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`I299 %`})`;
      await tx`DELETE FROM modules WHERE display_name LIKE ${"I299 %"}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

let templateId = "";

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "I299 TPL",
    html: `<body><caelo-slot name="content">_</caelo-slot><caelo-slot name="sidebar">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, systemCtx, "template_blocks.set", {
    templateId,
    blocks: [
      { name: "content", displayName: "Content", position: 0 },
      { name: "sidebar", displayName: "Sidebar", position: 1 },
    ],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("pages.build_page — happy path", () => {
  let pageId = "";
  let sharedCiId = "";

  it("creates page + mints modules + instances + placements in one call", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: PAGE_SLUG, title: "I299 Page", templateId },
      modules: [
        {
          blockName: "content",
          displayName: "I299 Hero",
          description: "Test hero",
          kind: "hero",
          html: "<section><h1>{{hero_title}}</h1></section>",
          fields: [{ name: "hero_title", kind: "text", label: "Hero title" }],
          content: { source: "inline", values: { hero_title: "Welcome" } },
        },
        {
          blockName: "content",
          displayName: "I299 CTA",
          description: "Shared CTA",
          kind: "cta",
          html: '<a href="{{cta_href}}">{{cta_label}}</a>',
          fields: [
            { name: "cta_label", kind: "text", label: "Label" },
            { name: "cta_href", kind: "url", label: "Href" },
          ],
          content: {
            source: "shared",
            purpose: "I299 CTA shared across test pages",
            slug: SHARED_CI_SLUG,
            values: { cta_label: "Go", cta_href: "/signup" },
          },
        },
        {
          blockName: "sidebar",
          displayName: "I299 Aside",
          description: "Sidebar box",
          kind: "content",
          html: "<aside>{{body}}</aside>",
          fields: [{ name: "body", kind: "text", label: "Body" }],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      pageId: string;
      createdPage: boolean;
      placements: {
        blockName: string;
        position: number;
        moduleId: string;
        contentInstanceId: string;
        syncMode: string;
        minted: boolean;
      }[];
    };
    pageId = v.pageId;
    expect(v.createdPage).toBe(true);
    expect(v.placements).toHaveLength(3);
    expect(v.placements.map((p) => [p.blockName, p.position])).toEqual([
      ["content", 0],
      ["content", 1],
      ["sidebar", 0],
    ]);
    expect(v.placements.every((p) => p.minted)).toBe(true);
    // inline + omitted content → unsynced; shared → synced by default.
    expect(v.placements[0]!.syncMode).toBe("unsynced");
    expect(v.placements[1]!.syncMode).toBe("synced");
    expect(v.placements[2]!.syncMode).toBe("unsynced");
    sharedCiId = v.placements[1]!.contentInstanceId;
  });

  it("pages.get_with_modules sees the assembled layout + bindings", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.get_with_modules", { pageId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const page = (
      r.value as {
        page: {
          blocks: {
            blockName: string;
            modules: { displayName: string; contentInstanceId: string | null; syncMode: string }[];
          }[];
        };
      }
    ).page;
    const content = page.blocks.find((b) => b.blockName === "content");
    expect(content?.modules.map((m) => m.displayName)).toEqual(["I299 Hero", "I299 CTA"]);
    expect(content?.modules[1]?.contentInstanceId).toBe(sharedCiId);
    expect(content?.modules[1]?.syncMode).toBe("synced");
  });

  it("the shared instance carries purpose + values", async () => {
    const r = await execute(registry, adapter, systemCtx, "content_instances.get", {
      id: sharedCiId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inst = (
      r.value as { instance: { purpose: string | null; values: Record<string, unknown> } }
    ).instance;
    expect(inst.purpose).toBe("I299 CTA shared across test pages");
    expect(inst.values.cta_label).toBe("Go");
  });

  it("existing-page mode APPENDS a reused module bound to the existing shared instance", async () => {
    const g = await execute(registry, adapter, systemCtx, "content_instances.get", {
      id: sharedCiId,
    });
    if (!g.ok) throw new Error("ci get failed");
    const ctaModuleId = (g.value as { instance: { moduleId: string } }).instance.moduleId;

    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { pageId },
      modules: [
        {
          blockName: "content",
          // Place mode — reuse the CTA module minted above.
          moduleId: ctaModuleId,
          content: { source: "existing", contentInstanceId: sharedCiId, syncMode: "synced" },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      createdPage: boolean;
      placements: { position: number; minted: boolean; contentInstanceId: string }[];
    };
    expect(v.createdPage).toBe(false);
    // Appended after the two existing content-block modules.
    expect(v.placements[0]!.position).toBe(2);
    expect(v.placements[0]!.minted).toBe(false);
    expect(v.placements[0]!.contentInstanceId).toBe(sharedCiId);
  });
});

describe("pages.build_page — mid-batch abort (§11: partial failure impossible)", () => {
  it("unknown block on modules[1] aborts and rolls back the page create", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: PAGE_SLUG_ABORT, title: "I299 Abort", templateId },
      modules: [
        {
          blockName: "content",
          displayName: "I299 Abort Hero",
          html: "<section>{{t}}</section>",
          fields: [{ name: "t", kind: "text", label: "T" }],
        },
        {
          blockName: "does-not-exist",
          displayName: "I299 Abort Two",
          html: "<p>{{t}}</p>",
          fields: [{ name: "t", kind: "text", label: "T" }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msg = (r.error as { message?: string }).message ?? "";
    // Names the failing module index + the valid block set.
    expect(msg).toContain("modules[1]");
    expect(msg).toContain("does-not-exist");
    expect(msg).toContain("content");

    // The whole tx rolled back: no page, no modules.
    const pages = await execute(registry, adapter, systemCtx, "pages.list", {});
    if (!pages.ok) throw new Error("pages.list failed");
    const slugs = (pages.value as { pages: { slug: string }[] }).pages.map((p) => p.slug);
    expect(slugs).not.toContain(PAGE_SLUG_ABORT);

    const mods = await execute(registry, adapter, systemCtx, "modules.list", {});
    if (!mods.ok) throw new Error("modules.list failed");
    const names = (mods.value as { modules: { displayName: string }[] }).modules.map(
      (m) => m.displayName,
    );
    expect(names).not.toContain("I299 Abort Hero");
  });

  it("a chrome block (header) routes to add_module target='layout' instead of a bare block list (run-B5 max_loops)", async () => {
    // The template only has `content`; the model conflated the LAYOUT's
    // header block (seen in list_layouts) with a page block. Without the
    // routing hint it re-tried build_page until max_loops. The error now
    // names the fix.
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: `${PAGE_SLUG_ABORT}-chrome`, title: "I299 Chrome", templateId },
      modules: [
        {
          blockName: "header",
          displayName: "Site Header",
          html: "<header>{{brand}}</header>",
          fields: [{ name: "brand", kind: "text", label: "Brand", default: "Acme" }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msg = (r.error as { message?: string }).message ?? "";
    expect(msg).toContain("LAYOUT chrome");
    expect(msg).toContain("add_module");
    expect(msg).toContain("target:'layout'");
    expect(msg).toContain("list_layouts");
  });

  it("bad field value on modules[1] content aborts, naming index AND field", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: PAGE_SLUG_FIELD, title: "I299 Field", templateId },
      modules: [
        {
          blockName: "content",
          displayName: "I299 Field One",
          html: "<p>{{t}}</p>",
          fields: [{ name: "t", kind: "text", label: "T" }],
        },
        {
          blockName: "content",
          displayName: "I299 Field Two",
          html: "<p>{{count}}</p>",
          fields: [{ name: "count", kind: "number", label: "Count" }],
          content: { source: "inline", values: { count: "not-a-number" } },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msg = (r.error as { message?: string }).message ?? "";
    expect(msg).toContain("modules[1]");
    expect(msg).toContain('"count"');

    // Atomicity: modules[0]'s mint rolled back with everything else.
    const mods = await execute(registry, adapter, systemCtx, "modules.list", {});
    if (!mods.ok) throw new Error("modules.list failed");
    const names = (mods.value as { modules: { displayName: string }[] }).modules.map(
      (m) => m.displayName,
    );
    expect(names).not.toContain("I299 Field One");
    const pages = await execute(registry, adapter, systemCtx, "pages.list", {});
    if (!pages.ok) throw new Error("pages.list failed");
    const slugs = (pages.value as { pages: { slug: string }[] }).pages.map((p) => p.slug);
    expect(slugs).not.toContain(PAGE_SLUG_FIELD);
  });
});

describe("content_instances.create_many + page_module_content.set_many", () => {
  let moduleId = "";
  let pageId = "";

  beforeAll(async () => {
    // A page with two placements of one module, built via build_page.
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: `i299-many-${TS}`, title: "I299 Many", templateId },
      modules: [
        {
          blockName: "content",
          displayName: "I299 Many Mod",
          html: "<p>{{txt}}</p>",
          fields: [{ name: "txt", kind: "text", label: "Text" }],
        },
      ],
    });
    if (!r.ok) throw new Error(`seed build_page failed: ${JSON.stringify(r.error)}`);
    const v = r.value as { pageId: string; placements: { moduleId: string }[] };
    pageId = v.pageId;
    moduleId = v.placements[0]!.moduleId;
    const r2 = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { pageId },
      modules: [{ blockName: "content", moduleId }],
    });
    if (!r2.ok) throw new Error("seed second placement failed");
  });

  it("create_many mints a batch in one tx", async () => {
    const r = await execute(registry, adapter, systemCtx, "content_instances.create_many", {
      instances: [
        { moduleId, values: { txt: "a" } },
        { moduleId, purpose: "I299 batch shared", values: { txt: "b" } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { contentInstanceIds: string[] }).contentInstanceIds).toHaveLength(2);
  });

  it("create_many aborts the whole batch when one item is invalid", async () => {
    const before = await execute(registry, adapter, systemCtx, "content_instances.list", {
      moduleId,
    });
    if (!before.ok) throw new Error("list failed");
    const countBefore = (before.value as { instances: unknown[] }).instances.length;

    const r = await execute(registry, adapter, systemCtx, "content_instances.create_many", {
      instances: [
        { moduleId, values: { txt: "ok" } },
        // Valid UUID shape, nonexistent module — fails in the handler
        // AFTER instances[0] wrote, exercising the abort-and-rollback path.
        { moduleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", values: {} },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { message?: string }).message).toContain("instances[1]");

    const after = await execute(registry, adapter, systemCtx, "content_instances.list", {
      moduleId,
    });
    if (!after.ok) throw new Error("list failed");
    expect((after.value as { instances: unknown[] }).instances).toHaveLength(countBefore);
  });

  it("set_many fills both placements in one tx", async () => {
    const r = await execute(registry, adapter, systemCtx, "page_module_content.set_many", {
      items: [
        { pageId, blockName: "content", position: 0, contentValues: { txt: "first" } },
        { pageId, blockName: "content", position: 1, contentValues: { txt: "second" } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { updated: number }).updated).toBe(2);
  });

  it("set_many aborts the whole batch on a bad placement, naming items[i]", async () => {
    const r = await execute(registry, adapter, systemCtx, "page_module_content.set_many", {
      items: [
        { pageId, blockName: "content", position: 0, contentValues: { txt: "changed" } },
        { pageId, blockName: "content", position: 99, contentValues: { txt: "nope" } },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { message?: string }).message).toContain("items[1]");

    // items[0]'s write rolled back — position 0 still says "first".
    const g = await execute(registry, adapter, systemCtx, "pages.get_with_modules", { pageId });
    if (!g.ok) throw new Error("get failed");
    const block = (
      g.value as {
        page: { blocks: { blockName: string; modules: { contentInstanceId: string | null }[] }[] };
      }
    ).page.blocks.find((b) => b.blockName === "content");
    const ciId = block?.modules[0]?.contentInstanceId;
    if (!ciId) throw new Error("placement lost its binding");
    const ci = await execute(registry, adapter, systemCtx, "content_instances.get", { id: ciId });
    if (!ci.ok) throw new Error("ci get failed");
    expect(
      (ci.value as { instance: { values: Record<string, unknown> } }).instance.values.txt,
    ).toBe("first");
  });
});

describe("pages.build_page — detached entries + {$ref} nested composition (one call)", () => {
  it("mints a detached Button, embeds it via {$ref} in the CTA's module field, all in one call", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: `i299-ref-${TS}`, title: "Ref Page", templateId },
      modules: [
        {
          ref: "btn",
          // no blockName → detached (nested-only)
          displayName: "Ref Button",
          description: "Nested-only CTA button.",
          kind: "cta",
          type: "button",
          html: "<button>{{label}}</button>",
          fields: [{ name: "label", kind: "text", label: "Label" }],
          content: { source: "inline", values: { label: "Click me" } },
        },
        {
          blockName: "content",
          displayName: "Ref CTA Teaser",
          description: "Teaser that embeds the button.",
          kind: "cta",
          html: "<section><h2>{{headline}}</h2>{{>cta}}</section>",
          fields: [
            { name: "headline", kind: "text", label: "Headline" },
            { name: "cta", kind: "module", label: "CTA", allowedModuleTypes: ["button"] },
          ],
          content: {
            source: "inline",
            values: { headline: "Ready?", cta: { $ref: "btn" } },
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      placements: { moduleId: string; contentInstanceId: string }[];
      detached: { ref: string; moduleId: string; contentInstanceId: string }[];
    };
    // ONE placement (the teaser); the button is detached, not placed.
    expect(v.placements.length).toBe(1);
    expect(v.detached.length).toBe(1);
    expect(v.detached[0]?.ref).toBe("btn");

    // The teaser's content_instance carries the RESOLVED nested ref —
    // the button's real ids, not the {$ref} marker.
    const teaserCiId = v.placements[0]?.contentInstanceId as string;
    const ci = await execute(registry, adapter, systemCtx, "content_instances.get", {
      id: teaserCiId,
    });
    if (!ci.ok) throw new Error("teaser ci get failed");
    const cta = (ci.value as { instance: { values: { cta?: Record<string, unknown> } } }).instance
      .values.cta;
    expect(cta?.moduleId).toBe(v.detached[0]?.moduleId);
    expect(cta?.contentInstanceId).toBe(v.detached[0]?.contentInstanceId);
  });

  it("a {$ref} pointing at a LATER (or unknown) entry fails loudly with the available handles", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: `i299-refbad-${TS}`, title: "Ref Bad", templateId },
      modules: [
        {
          blockName: "content",
          displayName: "Orphan Teaser",
          description: "References a handle that doesn't exist yet.",
          kind: "cta",
          html: "<section>{{>cta}}</section>",
          fields: [{ name: "cta", kind: "module", label: "CTA" }],
          content: { source: "inline", values: { cta: { $ref: "nope" } } },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msg = (r.error as { message?: string }).message ?? "";
    expect(msg).toContain('"$ref"');
    expect(msg).toContain("EARLIER");
  });

  it('moduleId {"$ref"} re-places a module minted earlier in the SAME call (run-A regression)', async () => {
    // The live model wrote moduleId:"$feat1" to reuse one card module for
    // three placements — now expressible as moduleId:{"$ref":"card"}.
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: `i299-mref-${TS}`, title: "ModRef", templateId },
      modules: [
        {
          ref: "card",
          blockName: "content",
          displayName: "Ref Card",
          description: "Feature card used three times.",
          kind: "content",
          type: "feature-card",
          html: "<div>{{txt}}</div>",
          fields: [{ name: "txt", kind: "text", label: "Text" }],
          content: { source: "inline", values: { txt: "one" } },
        },
        {
          blockName: "content",
          moduleId: { $ref: "card" },
          content: { source: "inline", values: { txt: "two" } },
        },
        {
          blockName: "content",
          moduleId: { $ref: "card" },
          content: { source: "inline", values: { txt: "three" } },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      placements: { moduleId: string; contentInstanceId: string }[];
    };
    expect(v.placements.length).toBe(3);
    // One module, three placements, three DISTINCT instances.
    expect(new Set(v.placements.map((p) => p.moduleId)).size).toBe(1);
    expect(new Set(v.placements.map((p) => p.contentInstanceId)).size).toBe(3);
  });

  it("a detached entry without ref is rejected at the schema boundary", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: `i299-refnob-${TS}`, title: "Ref NoB", templateId },
      modules: [
        {
          displayName: "Floating",
          description: "No blockName, no ref — unreachable.",
          kind: "content",
          html: "<div>{{txt}}</div>",
          fields: [{ name: "txt", kind: "text", label: "Text" }],
        },
      ],
    });
    expect(r.ok).toBe(false);
  });
});
