// SPDX-License-Identifier: MPL-2.0

/**
 * #917 — `page_module_content.patch_fields` (Live Edit in-place text editing)
 * and the preview's edit markers.
 *
 * Pins: only the edited fields/items change, all edits of a call or none; the operator's plain
 * text is escaped once; non-text kinds, bad indexes and synced
 * placements are refused with an operator-readable message; a branched
 * edit stays on the chat's branch; `pages.render_preview` emits markers
 * only when asked.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";

import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TPL_SLUG = "i917-patch-tpl";
const MOD_SLUG = "i917-patch-mod";
const PAGE_SLUG = "i917-patch-page";
const SHARED_PAGE_SLUG = "i917-patch-shared";
const SYSTEM_ACTOR = "00000000-0000-0000-0000-00000000ffff";
const CHAT_BRANCH_ID = "33333333-3333-4333-8333-917917917917";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";
let sharedPageId = "";

function ctx(branchId?: string): ExecutionContext {
  return {
    actorId: SYSTEM_ACTOR,
    actorKind: "system",
    requestId: "page-module-text-test",
    ...(branchId ? { chatBranchId: branchId } : {}),
  };
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const pages = [PAGE_SLUG, SHARED_PAGE_SLUG];
      await tx`DELETE FROM page_layout_snapshots WHERE page_id IN (SELECT id FROM pages WHERE slug IN ${sql(pages)})`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug IN ${sql(pages)})`;
      await tx`DELETE FROM pages WHERE slug IN ${sql(pages)}`;
      await tx`DELETE FROM content_instance_snapshots WHERE content_instance_id IN (SELECT ci.id FROM content_instances ci JOIN modules m ON m.id = ci.module_id WHERE m.slug = ${MOD_SLUG})`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug = ${MOD_SLUG})`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

async function run(op: string, input: unknown, branchId?: string) {
  return execute(registry, adapter, ctx(branchId), op, input);
}

async function must<T>(op: string, input: unknown, branchId?: string): Promise<T> {
  const r = await run(op, input, branchId);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** The page as the preview renders it (on the branch when given). */
async function previewHtml(page: string, branchId?: string): Promise<string> {
  const preview = await must<{ html: string }>(
    "pages.render_preview",
    { pageId: page, ...(branchId ? { chatBranchId: branchId } : {}) },
    branchId,
  );
  return preview.html;
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const { templateId } = await must<{ templateId: string }>("templates.create", {
    slug: TPL_SLUG,
    displayName: "patch_fields tpl",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content"></caelo-slot></body></html>`,
    css: "",
  });
  await must("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { moduleId } = await must<{ moduleId: string }>("modules.create", {
    slug: MOD_SLUG,
    displayName: "patch_fields mod",
    html: '<section><h1>{{title}}</h1><ul>{{#tags}}<li>{{.}}</li>{{/tags}}</ul><nav>{{#links}}<a href="{{href}}">{{label}}</a>{{/links}}</nav><img src="{{photo}}" alt="{{title}}"></section>',
    css: "",
    js: "",
    fields: [
      { name: "title", kind: "text", label: "Title" },
      { name: "tags", kind: "text-list", label: "Tags" },
      { name: "links", kind: "link-list", label: "Links" },
      { name: "photo", kind: "url", label: "Photo" },
    ],
  });
  for (const slug of [PAGE_SLUG, SHARED_PAGE_SLUG]) {
    const { pageId: id } = await must<{ pageId: string }>("pages.create", {
      slug,
      name: slug,
      title: slug,
      templateId,
    });
    await must("pages.set_modules", {
      pageId: id,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    if (slug === PAGE_SLUG) pageId = id;
    else sharedPageId = id;
  }
  await must("page_module_content.set", {
    pageId,
    blockName: "content",
    position: 0,
    contentValues: {
      title: "Welcome",
      tags: ["one", "two"],
      links: [{ label: "Docs", href: "https://example.com/docs" }],
      photo: "https://example.com/p.png",
    },
  });
  // A synced placement: bind the second page to a shared instance.
  const { contentInstanceId } = await must<{ contentInstanceId: string }>(
    "content_instances.create",
    {
      moduleId,
      values: { title: "Shared" },
    },
  );
  await must("placement.set_content", {
    pageId: sharedPageId,
    blockName: "content",
    position: 0,
    contentInstanceId,
    syncMode: "synced",
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

const at = { blockName: "content", position: 0 };

describe("page_module_content.patch_fields (#917)", () => {
  it("changes one text field, escapes it once, and leaves the rest alone", async () => {
    await must("page_module_content.patch_fields", {
      pageId,
      ...at,
      edits: [{ field: "title", text: "Fish & <chips>" }],
    });
    const html = await previewHtml(pageId);
    expect(html).toContain("<h1>Fish &amp; &lt;chips&gt;</h1>");
    expect(html).toContain("<li>one</li><li>two</li>");
    expect(html).toContain('<a href="https://example.com/docs">Docs</a>');
    expect(html).toContain('src="https://example.com/p.png"');
  });

  it("changes a text-list item and a link-list label by index", async () => {
    await must("page_module_content.patch_fields", {
      pageId,
      ...at,
      edits: [{ field: "tags", index: 1, text: "zwei" }],
    });
    await must("page_module_content.patch_fields", {
      pageId,
      ...at,
      edits: [{ field: "links", index: 0, text: "Handbook" }],
    });
    const html = await previewHtml(pageId);
    expect(html).toContain("<li>one</li><li>zwei</li>");
    expect(html).toContain('<a href="https://example.com/docs">Handbook</a>');
  });

  it("refuses non-text kinds, bad indexes, unknown fields and synced placements", async () => {
    const refused = async (input: Record<string, unknown>, pattern: RegExp) => {
      const { pageId: page = pageId, ...edit } = input;
      const r = await run("page_module_content.patch_fields", {
        pageId: page,
        ...at,
        edits: [{ text: "x", ...edit }],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect((r.error as { message?: string }).message ?? "").toMatch(pattern);
    };
    await refused({ field: "photo" }, /cannot be edited as plain text/);
    await refused({ field: "tags", index: 9 }, /item 9 does not exist/);
    await refused({ field: "tags" }, /needs the item index/);
    await refused({ field: "title", index: 0 }, /takes no index/);
    await refused({ field: "nope" }, /no field "nope"/);
    await refused({ pageId: sharedPageId, field: "title" }, /shared with other pages/);
  });

  it("applies all edits of a call or none", async () => {
    await must("page_module_content.patch_fields", {
      pageId,
      ...at,
      edits: [
        { field: "tags", index: 0, text: "uno" },
        { field: "links", index: 0, text: "Guide" },
      ],
    });
    const html = await previewHtml(pageId);
    expect(html).toContain("<li>uno</li>");
    expect(html).toContain('<a href="https://example.com/docs">Guide</a>');
    const r = await run("page_module_content.patch_fields", {
      pageId,
      ...at,
      edits: [
        { field: "title", text: "Never stored" },
        { field: "photo", text: "x" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(await previewHtml(pageId)).not.toContain("Never stored");
  });

  it("keeps a branched edit on the chat's branch", async () => {
    await must(
      "page_module_content.patch_fields",
      { pageId, ...at, edits: [{ field: "title", text: "Branch only" }] },
      CHAT_BRANCH_ID,
    );
    expect(await previewHtml(pageId, CHAT_BRANCH_ID)).toContain("<h1>Branch only</h1>");
    expect(await previewHtml(pageId)).not.toContain("Branch only");
  });
});

describe("pages.render_preview edit markers (#917)", () => {
  it("marks placement text only when asked, never attributes", async () => {
    const plain = await must<{ html: string }>("pages.render_preview", { pageId });
    expect(plain.html).not.toContain("caelo:f");
    const marked = await must<{ html: string }>("pages.render_preview", {
      pageId,
      editMarkers: true,
    });
    expect(marked.html).toContain(
      "<h1><!--caelo:f p=content%230 s=0 f=title-->Fish &amp; &lt;chips&gt;<!--/caelo:f--></h1>",
    );
    expect(marked.html).toContain("<!--caelo:f p=content%230 s=0 f=tags.1-->zwei<!--/caelo:f-->");
    expect(marked.html).toContain(
      "<!--caelo:f p=content%230 s=0 f=links.0.label-->Guide<!--/caelo:f-->",
    );
    expect(marked.html).toContain('alt="Fish &amp; &lt;chips&gt;"');
    expect(marked.html).not.toMatch(/[\uE000-\uE002]/);
    const shared = await must<{ html: string }>("pages.render_preview", {
      pageId: sharedPageId,
      editMarkers: true,
    });
    expect(shared.html).toContain("<!--caelo:f p=content%230 s=1 f=title-->Shared<!--/caelo:f-->");
  });
});
