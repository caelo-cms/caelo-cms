// SPDX-License-Identifier: MPL-2.0

/**
 * #917 — `page_module_content.patch_fields` (Live Edit in-place text editing)
 * and the preview's edit markers.
 *
 * Pins: only the edited fields/items change, all edits of a call or none; the operator's plain
 * text is escaped once; non-text kinds, unknown list entries and synced
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
const SHARED_TWIN_SLUG = "i918-patch-shared-twin";
const SYSTEM_ACTOR = "00000000-0000-0000-0000-00000000ffff";
const CHAT_BRANCH_ID = "33333333-3333-4333-8333-917917917917";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";
let sharedPageId = "";
let twinPageId = "";
let sharedInstanceId = "";

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
      const pages = [PAGE_SLUG, SHARED_PAGE_SLUG, SHARED_TWIN_SLUG];
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
/** Entry ids of the local lists (epic #1107): edits address entries by id. */
const TAG1 = "00000000-0000-4000-9000-000000000001";
const TAG2 = "00000000-0000-4000-9000-000000000002";
const LINK1 = "00000000-0000-4000-9000-000000000003";

async function previewHtml(page: string, branchId?: string): Promise<string> {
  const preview = await must<{ html: string }>(
    "pages.render_preview",
    { pageId: page, ...(branchId ? { chatBranchId: branchId } : {}) },
    branchId,
  );
  // List entries carry their item address; these assertions read the markup.
  return preview.html.replace(/ data-caelo-list-item="[^"]*"/g, "");
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const { templateId } = await must<{ templateId: string }>("templates.create", {
    pageType: "home",
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
    html: '<section><h1>{{title}}</h1><ul>{{#tags}}<li>{{text}}</li>{{/tags}}</ul><nav>{{#links}}<a href="{{link}}">{{label}}</a>{{/links}}</nav><img src="{{photo}}" alt="{{title}}"><a class="cta" href="{{cta}}">Go</a><b>{{count}}</b></section>',
    css: "",
    js: "",
    fields: [
      { name: "title", kind: "text", label: "Title" },
      { name: "tags", kind: "list", listType: "texts", label: "Tags" },
      { name: "links", kind: "list", listType: "links", label: "Links" },
      { name: "photo", kind: "image", label: "Photo" },
      { name: "cta", kind: "url", label: "Button target" },
      { name: "count", kind: "number", label: "Count" },
    ],
  });
  for (const slug of [PAGE_SLUG, SHARED_PAGE_SLUG, SHARED_TWIN_SLUG]) {
    const { pageId: id } = await must<{ pageId: string }>("pages.create", {
      slug,
      shortTitle: slug,
      title: slug,
      templateId,
    });
    await must("pages.set_modules", {
      pageId: id,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    if (slug === PAGE_SLUG) pageId = id;
    else if (slug === SHARED_PAGE_SLUG) sharedPageId = id;
    else twinPageId = id;
  }
  await must("page_module_content.set", {
    pageId,
    blockName: "content",
    position: 0,
    contentValues: {
      title: "Welcome",
      tags: [
        { id: TAG1, node: "text", values: { text: "one" } },
        { id: TAG2, node: "text", values: { text: "two" } },
      ],
      links: [
        {
          id: LINK1,
          node: "link",
          values: { label: "Docs", link: { href: "https://example.com/docs" } },
        },
      ],
      photo: "https://example.com/p.png",
      cta: "https://example.com/start",
      count: 3,
    },
  });
  // Synced placements: two pages show the same shared instance.
  const { contentInstanceId } = await must<{ contentInstanceId: string }>(
    "content_instances.create",
    {
      moduleId,
      values: { title: "Shared" },
    },
  );
  sharedInstanceId = contentInstanceId;
  for (const id of [sharedPageId, twinPageId]) {
    await must("placement.set_content", {
      pageId: id,
      blockName: "content",
      position: 0,
      contentInstanceId,
      syncMode: "synced",
    });
  }
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

  it("changes a list entry's text and a link label by entry id", async () => {
    await must("page_module_content.patch_fields", {
      pageId,
      ...at,
      edits: [{ field: "tags", item: TAG2, key: "text", text: "zwei" }],
    });
    await must("page_module_content.patch_fields", {
      pageId,
      ...at,
      edits: [{ field: "links", item: LINK1, key: "label", text: "Handbook" }],
    });
    const html = await previewHtml(pageId);
    expect(html).toContain("<li>one</li><li>zwei</li>");
    expect(html).toContain('<a href="https://example.com/docs">Handbook</a>');
  });

  it("refuses non-text kinds, unknown entries, unknown fields and synced placements", async () => {
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
    await refused({ field: "count" }, /cannot be edited here/);
    await refused(
      { field: "tags", item: "00000000-0000-4000-9000-000000000099", key: "text" },
      /entry 00000000-0000-4000-9000-000000000099 does not exist/,
    );
    await refused({ field: "tags" }, /needs the entry \(item\) and its field \(key\)/);
    await refused({ field: "title", item: TAG1, key: "text" }, /takes no item, key or part/);
    await refused({ field: "nope" }, /no field "nope"/);
    await refused({ pageId: sharedPageId, field: "title" }, /shared with other pages/);
    await refused({ field: "cta", text: "javascript:alert(1)" }, /not a valid link target/);
    await refused({ field: "cta", text: '/x" onmouseover="alert(1)' }, /not a valid link target/);
    await refused(
      { field: "links", item: LINK1, key: "link", part: "href", text: "no spaces allowed" },
      /not a valid link target/,
    );
    await refused({ field: "photo", text: "mailto:a@b.c" }, /not a valid image address/);
  });

  it("applies all edits of a call or none", async () => {
    await must("page_module_content.patch_fields", {
      pageId,
      ...at,
      edits: [
        { field: "tags", item: TAG1, key: "text", text: "uno" },
        { field: "links", item: LINK1, key: "label", text: "Guide" },
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
        { field: "count", text: "x" },
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

describe("a chat archived between load and save (#1102)", () => {
  it("refuses the save with the next step and keeps nothing of it", async () => {
    const { chatSessionId, chatBranchId } = await must<{
      chatSessionId: string;
      chatBranchId: string;
    }>("chat.create_session", { title: "i1102 closed chat" });
    // Live Edit loaded this chat; meanwhile another tab archives it.
    await must("chat.archive_session", { chatSessionId });
    const r = await execute(
      registry,
      adapter,
      { ...ctx(chatBranchId), chatTaskId: chatSessionId },
      "page_module_content.patch_fields",
      { pageId, ...at, edits: [{ field: "title", text: "Lost save" }] },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("HandlerError");
    if (r.error.kind === "HandlerError") {
      expect(r.error.message).toContain("this chat was archived, so the change was not saved");
      expect(r.error.message).toContain("open chat");
    }
    expect(await previewHtml(pageId, chatBranchId)).not.toContain("Lost save");
    const sql = new SQL(ADMIN_URL!);
    try {
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return tx`SELECT count(*)::int AS n FROM site_snapshots WHERE chat_task_id = ${chatSessionId}::uuid`;
      });
      expect(rows[0].n).toBe(0);
    } finally {
      await sql.end();
    }
  });
});

describe("links, images and shared content (#918)", () => {
  it("changes a link's label and target, a url field and an image in one call", async () => {
    await must("page_module_content.patch_fields", {
      pageId,
      ...at,
      edits: [
        { field: "links", item: LINK1, key: "link", part: "href", text: ` /${SHARED_PAGE_SLUG} ` },
        { field: "cta", text: "https://example.com/start?a=1" },
        { field: "photo", text: "https://example.com/m/cup.webp" },
      ],
    });
    const html = await previewHtml(pageId);
    // Stored as a page reference (#724), rendered in the site's URL style.
    expect(html).toContain(`<a href="/${SHARED_PAGE_SLUG}/">Guide</a>`);
    expect(html).toContain('<a class="cta" href="https://example.com/start?a=1">Go</a>');
    expect(html).toContain('src="https://example.com/m/cup.webp"');
  });

  it("refuses a link target that is no page, with the next step", async () => {
    // The write goes through content_instances.set_values, which checks
    // internal links (#724): a typo in Live Edit's link editor is refused
    // instead of stored as a dead link.
    const r = await run("page_module_content.patch_fields", {
      pageId,
      ...at,
      edits: [{ field: "links", item: LINK1, key: "link", part: "href", text: "/no-such-page" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("is not the path of any page");
  });

  it('"everywhere" changes every page that shows the shared content', async () => {
    await must("page_module_content.patch_fields", {
      pageId: sharedPageId,
      ...at,
      edits: [{ field: "title", text: "Shared, changed" }],
      scope: "everywhere",
    });
    expect(await previewHtml(sharedPageId)).toContain("<h1>Shared, changed</h1>");
    expect(await previewHtml(twinPageId)).toContain("<h1>Shared, changed</h1>");
  });

  it('"here" detaches this page and changes only it', async () => {
    const r = await must<{ contentInstanceId: string }>("page_module_content.patch_fields", {
      pageId: twinPageId,
      ...at,
      edits: [{ field: "title", text: "Only the twin" }],
      scope: "here",
    });
    expect(r.contentInstanceId).not.toBe(sharedInstanceId);
    expect(await previewHtml(twinPageId)).toContain("<h1>Only the twin</h1>");
    expect(await previewHtml(sharedPageId)).toContain("<h1>Shared, changed</h1>");
    const marked = await must<{ html: string }>("pages.render_preview", {
      pageId: twinPageId,
      editMarkers: true,
    });
    expect(marked.html).toContain("<!--caelo:f p=content%230 s=0 f=title-->");
  });
});

describe("shared content on a chat branch (#918)", () => {
  it('"here" detaches the placement on the branch only', async () => {
    const r = await must<{ contentInstanceId: string }>(
      "page_module_content.patch_fields",
      {
        pageId: sharedPageId,
        ...at,
        edits: [{ field: "title", text: "Branch fork" }],
        scope: "here",
      },
      CHAT_BRANCH_ID,
    );
    expect(r.contentInstanceId).not.toBe(sharedInstanceId);
    expect(await previewHtml(sharedPageId, CHAT_BRANCH_ID)).toContain("<h1>Branch fork</h1>");
    const marked = await must<{ html: string }>(
      "pages.render_preview",
      { pageId: sharedPageId, chatBranchId: CHAT_BRANCH_ID, editMarkers: true },
      CHAT_BRANCH_ID,
    );
    expect(marked.html).toContain("<!--caelo:f p=content%230 s=0 f=title-->Branch fork");
    // Live is untouched: still the shared content.
    expect(await previewHtml(sharedPageId)).not.toContain("Branch fork");
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
    // List entries are marked by entry id (`-` encoded as %2D in comments).
    const enc = (path: string) => encodeURIComponent(path).replace(/-/g, "%2D");
    expect(marked.html).toContain(
      `<!--caelo:f p=content%230 s=0 f=${enc(`tags.${TAG2}.text`)}-->zwei<!--/caelo:f-->`,
    );
    expect(marked.html).toContain(
      `<!--caelo:f p=content%230 s=0 f=${enc(`links.${LINK1}.label`)}-->Guide<!--/caelo:f-->`,
    );
    expect(marked.html).toContain('alt="Fish &amp; &lt;chips&gt;"');
    expect(marked.html).not.toMatch(/[\uE000-\uE002]/);
    const shared = await must<{ html: string }>("pages.render_preview", {
      pageId: sharedPageId,
      editMarkers: true,
    });
    // The twin detached above, so the shared content is on one page now.
    expect(shared.html).toContain(
      "<!--caelo:f p=content%230 s=1 f=title-->Shared, changed<!--/caelo:f-->",
    );
    expect(marked.html).toContain(
      '<a class="cta" href="https://example.com/start?a=1" data-caelo-fields="href=cta" data-caelo-placement="content%230" data-caelo-shared="0">',
    );
  });
});
