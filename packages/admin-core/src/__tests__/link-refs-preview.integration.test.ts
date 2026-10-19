// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout B) — the editor preview resolves internal
 * references through the same shared index as the build.
 *
 * Covers: a `caelo:page/<id>` value renders as the target's path in the
 * publish target's style (anchor kept); a draft target resolves (the
 * editor shows drafts); a deleted target stays raw and surfaces as
 * `link-target-missing:page/<id>` in `missingSlots` (the editor's
 * missing-content channel the AI reads through inspect_page_render);
 * a malformed `caelo:` href is flagged as `link-ref-malformed:<raw>`;
 * a chat's own new and deleted pages resolve against the chat's branch
 * only; a media reference renders the editor's media URL.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { ToolRegistry } from "../ai/tools/dispatch.js";
import { inspectPageRenderTool } from "../ai/tools/inspect-page-render.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "link-refs-preview-test",
};

const PFX = `lrp-${Date.now().toString(36)}`;
// media_assets.sha256 of the seeded asset (hex, so it never collides with
// a real upload's digest pattern by accident).
const MEDIA_SHA_PREFIX = "7e1f0b02";
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
    await tx`DELETE FROM media_assets WHERE sha256 LIKE ${`${MEDIA_SHA_PREFIX}%`}`;
  });
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: `${PFX}-tpl`,
    displayName: `${PFX} TPL`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

async function buildPage(
  slug: string,
  status: "draft" | "published",
  html: string,
  values: Record<string, unknown>,
  fields: { name: string; kind: string; label: string }[],
): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.build_page", {
    page: { slug, title: `${PFX} ${slug}`, templateId, status },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} ${slug} Body`,
        description: "Page body.",
        kind: "content",
        html,
        fields,
        content: { source: "inline", values },
      },
    ],
  });
  if (!r.ok) throw new Error(`build_page ${slug}: ${JSON.stringify(r.error)}`);
  return (r.value as { pageId: string }).pageId;
}

async function preview(pageId: string): Promise<{ html: string; missingSlots: string[] }> {
  const r = await execute(registry, adapter, SYSTEM, "pages.render_preview", { pageId });
  if (!r.ok) throw new Error(`render_preview: ${JSON.stringify(r.error)}`);
  return r.value as { html: string; missingSlots: string[] };
}

/** The AI's next step per link marker, as inspect_page_render reports it. */
async function nextSteps(pageId: string): Promise<Record<string, string>> {
  const tools = new ToolRegistry();
  tools.register(inspectPageRenderTool);
  const r = await tools.dispatch("inspect_page_render", { pageId }, SYSTEM, { adapter, registry });
  if (!r.ok) throw new Error(`inspect_page_render: ${r.content}`);
  const out = JSON.parse(r.content) as { slots: { nextSteps?: Record<string, string> } };
  return out.slots.nextSteps ?? {};
}

const TEXT = [{ name: "body_text", kind: "text", label: "Body" }];
const LINK = [{ name: "target", kind: "url", label: "Target" }];

describe("pages.render_preview — internal references", () => {
  it("resolves to the target's path, drafts included, anchor kept", async () => {
    const draft = await buildPage(
      `${PFX}-draft`,
      "draft",
      "<p>{{body_text}}</p>",
      { body_text: "D" },
      TEXT,
    );
    const page = await buildPage(
      `${PFX}-linker`,
      "published",
      '<a class="x" href="{{target}}">Go</a>',
      { target: `caelo:page/${draft}#intro` },
      LINK,
    );
    const out = await preview(page);
    expect(out.html).toContain(`<a class="x" href="/${PFX}-draft/#intro"`);
    expect(out.missingSlots.filter((m) => m.startsWith("link-"))).toEqual([]);
  });

  it("follows a chat's pending rename in the chat's preview, not on main", async () => {
    const target = await buildPage(
      `${PFX}-old`,
      "published",
      "<p>{{body_text}}</p>",
      { body_text: "T" },
      TEXT,
    );
    const page = await buildPage(
      `${PFX}-ref`,
      "published",
      '<a class="z" href="{{target}}">T</a>',
      { target: `caelo:page/${target}` },
      LINK,
    );
    const session = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      isolation: "experiment",
      title: `${PFX}-chat`,
    });
    if (!session.ok) throw new Error(`session ${JSON.stringify(session.error)}`);
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    const chatCtx: ExecutionContext = { ...SYSTEM, chatBranchId, chatTaskId: chatSessionId };
    const renamed = await execute(registry, adapter, chatCtx, "pages.update", {
      pageId: target,
      slug: `${PFX}-new`,
    });
    expect(renamed.ok).toBe(true);

    const inChat = await execute(registry, adapter, chatCtx, "pages.render_preview", {
      pageId: page,
      chatBranchId,
    });
    if (!inChat.ok) throw new Error(`render_preview: ${JSON.stringify(inChat.error)}`);
    expect((inChat.value as { html: string }).html).toContain(`href="/${PFX}-new/"`);
    expect((await preview(page)).html).toContain(`href="/${PFX}-old/"`);
    await asSystem((tx) => tx`DELETE FROM chat_sessions WHERE id = ${chatSessionId}::uuid`);
  });

  it("flags a deleted target in missingSlots and keeps the reference raw", async () => {
    const gone = await buildPage(
      `${PFX}-gone`,
      "published",
      "<p>{{body_text}}</p>",
      { body_text: "G" },
      TEXT,
    );
    const page = await buildPage(
      `${PFX}-dangling`,
      "published",
      '<a class="y" href="{{target}}">Old</a>',
      { target: `caelo:page/${gone}` },
      LINK,
    );
    await asSystem((tx) => tx`UPDATE pages SET deleted_at = now() WHERE id = ${gone}::uuid`);
    const out = await preview(page);
    expect(out.html).toContain(`href="caelo:page/${gone}"`);
    expect(out.missingSlots).toContain(`link-target-missing:page/${gone}`);
    expect((await nextSteps(page))[`link-target-missing:page/${gone}`]).toContain(
      `grep_content("caelo:page/${gone}")`,
    );
  });

  it("flags a malformed caelo: href as link-ref-malformed and keeps it raw", async () => {
    const target = await buildPage(
      `${PFX}-mal-target`,
      "published",
      "<p>{{body_text}}</p>",
      { body_text: "M" },
      TEXT,
    );
    const page = await buildPage(
      `${PFX}-mal`,
      "published",
      `<a class="m" href="caelo:page/${target}/team">Team</a>`,
      {},
      [],
    );
    const out = await preview(page);
    expect(out.html).toContain(`href="caelo:page/${target}/team"`);
    expect(out.missingSlots).toContain(`link-ref-malformed:caelo:page/${target}/team`);
    expect((await nextSteps(page))[`link-ref-malformed:caelo:page/${target}/team`]).toContain(
      `grep_content("caelo:page/${target}/team")`,
    );
  });

  it("resolves the chat's own new page and flags its pending delete, on that branch only", async () => {
    const kept = await buildPage(
      `${PFX}-kept`,
      "published",
      "<p>{{body_text}}</p>",
      { body_text: "K" },
      TEXT,
    );
    const session = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      isolation: "experiment",
      title: `${PFX}-chat2`,
    });
    if (!session.ok) throw new Error(`session ${JSON.stringify(session.error)}`);
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    const chatCtx: ExecutionContext = { ...SYSTEM, chatBranchId, chatTaskId: chatSessionId };
    const created = await execute(registry, adapter, chatCtx, "pages.build_page", {
      page: { slug: `${PFX}-branch-new`, title: `${PFX} new`, templateId, status: "draft" },
      modules: [
        {
          blockName: "content",
          displayName: `${PFX} branch-new Body`,
          description: "Page body.",
          kind: "content",
          html: "<p>{{body_text}}</p>",
          fields: TEXT,
          content: { source: "inline", values: { body_text: "N" } },
        },
      ],
    });
    if (!created.ok) throw new Error(`branch build_page: ${JSON.stringify(created.error)}`);
    const fresh = (created.value as { pageId: string }).pageId;
    const page = await buildPage(
      `${PFX}-twolinks`,
      "published",
      '<a class="n" href="{{fresh_href}}">N</a><a class="k" href="{{kept_href}}">K</a>',
      { fresh_href: `caelo:page/${fresh}`, kept_href: `caelo:page/${kept}` },
      [
        { name: "fresh_href", kind: "url", label: "New" },
        { name: "kept_href", kind: "url", label: "Kept" },
      ],
    );
    const deleted = await execute(registry, adapter, chatCtx, "pages.delete", { pageId: kept });
    if (!deleted.ok) throw new Error(`branch delete: ${JSON.stringify(deleted.error)}`);

    const inChat = await execute(registry, adapter, chatCtx, "pages.render_preview", {
      pageId: page,
      chatBranchId,
    });
    if (!inChat.ok) throw new Error(`render_preview: ${JSON.stringify(inChat.error)}`);
    const chatOut = inChat.value as { html: string; missingSlots: string[] };
    expect(chatOut.html).toContain(`<a class="n" href="/${PFX}-branch-new/"`);
    expect(chatOut.html).toContain(`<a class="k" href="caelo:page/${kept}"`);
    expect(chatOut.missingSlots.filter((m) => m.startsWith("link-"))).toEqual([
      `link-target-missing:page/${kept}`,
    ]);

    // Main sees neither change: the chat's page does not exist there, the
    // deleted one is still live.
    const mainOut = await preview(page);
    expect(mainOut.html).toContain(`<a class="n" href="caelo:page/${fresh}"`);
    expect(mainOut.html).toContain(`<a class="k" href="/${PFX}-kept/"`);
    expect(mainOut.missingSlots.filter((m) => m.startsWith("link-"))).toEqual([
      `link-target-missing:page/${fresh}`,
    ]);
    await asSystem((tx) => tx`DELETE FROM chat_sessions WHERE id = ${chatSessionId}::uuid`);
  });

  it("renders a media reference as the editor's media URL, variant kept", async () => {
    const sha = `${MEDIA_SHA_PREFIX}${"c".repeat(56)}`;
    const upload = await execute(registry, adapter, SYSTEM, "media.upload", {
      sha256: sha,
      originalName: "brochure.pdf",
      name: `${PFX} Brochure`,
      mime: "application/pdf",
      sizeBytes: 4,
      width: null,
      height: null,
      alt: "",
      storageKey: `${sha}/orig.pdf`,
      variants: [
        {
          variant: "orig",
          format: "pdf",
          width: null,
          height: null,
          sizeBytes: 4,
          storageKey: `${sha}/orig.pdf`,
        },
      ],
    });
    if (!upload.ok) throw new Error(`media seed: ${JSON.stringify(upload.error)}`);
    const { assetId, slug } = upload.value as { assetId: string; slug: string };
    const page = await buildPage(
      `${PFX}-media`,
      "published",
      `<a class="f" href="caelo:media/${assetId}">PDF</a><a class="v" href="caelo:media/${assetId}/thumb-200">T</a>`,
      {},
      [],
    );
    const out = await preview(page);
    expect(out.html).toContain(`<a class="f" href="/_caelo/media/${slug}"`);
    expect(out.html).toContain(`<a class="v" href="/_caelo/media/${slug}/thumb-200"`);
    expect(out.missingSlots.filter((m) => m.startsWith("link-"))).toEqual([]);
  });
});
