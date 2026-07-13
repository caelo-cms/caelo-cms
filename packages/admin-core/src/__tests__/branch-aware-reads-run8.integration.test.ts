// SPDX-License-Identifier: MPL-2.0

/**
 * Run #8 R3 — branch-aware READ ops. Branched writes land in snapshot
 * tables only (module_snapshots / content_instance_snapshots); the live
 * rows stay untouched until publish. Before this fix the main read ops
 * returned the LIVE (published) state to a branch-scoped caller:
 *
 *   - `content_instances.get` returned pre-edit values after a branched
 *     `set_values`, so the AI re-edited content it had already written.
 *   - `pages.get_with_modules` returned the published module html/css
 *     after a branched `modules.update`, so rebuild loops re-edited
 *     modules they had already rewritten.
 *
 * Both ops now overlay the caller-branch snapshot state (same overlay
 * helpers the write paths + pages.render_preview use). Live reads
 * (no ctx.chatBranchId) still see only published state.
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

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "run8-branch-reads",
};

const TPL_SLUG = "run8-reads-tpl";
const PAGE_SLUG = "run8-reads-pg";
const MODULE_SLUG = "run8-reads-mod";
const CI_SLUG = "run8-reads-ci";
const SESSION_TITLE = "run8-reads-session";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'run8-reads-%'`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PAGE_SLUG}%`}`;
      // Both the explicit CI_SLUG row and any instance pages.set_modules
      // minted for the test modules (FK blocks the module delete otherwise).
      await tx`DELETE FROM content_instances
        WHERE slug = ${CI_SLUG}
           OR module_id IN (SELECT id FROM modules WHERE slug LIKE ${`${MODULE_SLUG}%`})`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${MODULE_SLUG}%`}`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${TPL_SLUG}%`}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("run #8 R3 — branch-aware read ops", () => {
  it("content_instances.get overlays branched set_values for the branch caller only", async () => {
    // Explicit fields: modules.create runs the extractor heuristic only
    // when the caller omits `fields`, and the extractor rejects a
    // placeholder without a declared field.
    const mod = await execute(registry, adapter, HUMAN, "modules.create", {
      slug: MODULE_SLUG,
      displayName: "M",
      html: "<div>{{title}}</div>",
      fields: [{ name: "title", kind: "text", label: "Title" }],
    });
    if (!mod.ok) throw new Error(`mod: ${JSON.stringify(mod.error)}`);
    const moduleId = (mod.value as { moduleId: string }).moduleId;

    const ci = await execute(registry, adapter, HUMAN, "content_instances.create", {
      moduleId,
      slug: CI_SLUG,
      displayName: "CI",
      values: { title: "published title" },
    });
    if (!ci.ok) throw new Error(`ci: ${JSON.stringify(ci.error)}`);
    const contentInstanceId = (ci.value as { contentInstanceId: string }).contentInstanceId;

    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: `${SESSION_TITLE}-ci`,
    });
    if (!session.ok) throw new Error("session");
    const { chatBranchId } = session.value as { chatBranchId: string };

    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "run8-reads-ci-ai",
      chatBranchId,
    };

    const edit = await execute(registry, adapter, aiCtx, "content_instances.set_values", {
      id: contentInstanceId,
      values: { title: "branched title" },
    });
    expect(edit.ok).toBe(true);

    // Branch caller reads its OWN pending edit back (the run #8
    // regression: this returned "published title" and the AI re-edited).
    const branchRead = await execute(registry, adapter, aiCtx, "content_instances.get", {
      id: contentInstanceId,
    });
    if (!branchRead.ok) throw new Error(`branch read: ${JSON.stringify(branchRead.error)}`);
    expect(
      (branchRead.value as { instance: { values: { title: string } } }).instance.values,
    ).toEqual({ title: "branched title" });

    // A branch-less caller still sees only the published values.
    const liveRead = await execute(registry, adapter, HUMAN, "content_instances.get", {
      id: contentInstanceId,
    });
    if (!liveRead.ok) throw new Error(`live read: ${JSON.stringify(liveRead.error)}`);
    expect((liveRead.value as { instance: { values: { title: string } } }).instance.values).toEqual(
      { title: "published title" },
    );
  });

  it("pages.get_with_modules overlays branched module code for the branch caller", async () => {
    const tpl = await execute(registry, adapter, HUMAN, "templates.create", {
      slug: TPL_SLUG,
      displayName: "T",
      html: "<main>{{content}}</main>",
      css: "",
    });
    if (!tpl.ok) throw new Error(`tpl: ${JSON.stringify(tpl.error)}`);
    const templateId = (tpl.value as { templateId: string }).templateId;

    const blocks = await execute(registry, adapter, HUMAN, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    if (!blocks.ok) throw new Error(`blocks: ${JSON.stringify(blocks.error)}`);

    const page = await execute(registry, adapter, HUMAN, "pages.create", {
      slug: PAGE_SLUG,
      locale: "en",
      title: "P",
      templateId,
      status: "draft",
    });
    if (!page.ok) throw new Error(`page: ${JSON.stringify(page.error)}`);
    const pageId = (page.value as { pageId: string }).pageId;

    // Explicit fields keep the literal html intact: without them the
    // extractor heuristic templatises "<div>published html</div>" into
    // "<div>{{divtext}}</div>" and the literal-html assertions below
    // compare against the wrong string. A declared-but-unreferenced
    // field is a legitimate state modules.create trusts verbatim.
    const mod = await execute(registry, adapter, HUMAN, "modules.create", {
      slug: `${MODULE_SLUG}-2`,
      displayName: "M2",
      html: "<div>published html</div>",
      fields: [{ name: "headline", kind: "text", label: "Headline" }],
    });
    if (!mod.ok) throw new Error(`mod2: ${JSON.stringify(mod.error)}`);
    const moduleId = (mod.value as { moduleId: string }).moduleId;

    // Live attach so BOTH branch and live readers see the placement.
    const attach = await execute(registry, adapter, HUMAN, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    expect(attach.ok).toBe(true);

    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: `${SESSION_TITLE}-mod`,
    });
    if (!session.ok) throw new Error("session");
    const { chatBranchId } = session.value as { chatBranchId: string };

    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "run8-reads-mod-ai",
      chatBranchId,
    };

    // Branched module rewrite — live `modules` row stays untouched.
    const edit = await execute(registry, adapter, aiCtx, "modules.update", {
      moduleId,
      html: "<div>branched html</div>",
    });
    expect(edit.ok).toBe(true);

    // Branch caller must read back ITS html (the run #8 regression:
    // this returned the published html and the rebuild re-edited).
    const branchRead = await execute(registry, adapter, aiCtx, "pages.get_with_modules", {
      pageId,
    });
    if (!branchRead.ok) throw new Error(`branch read: ${JSON.stringify(branchRead.error)}`);
    const branchBlocks = (
      branchRead.value as {
        page: { blocks: { blockName: string; modules: { moduleId: string; html: string }[] }[] };
      }
    ).page.blocks;
    const branchMod = branchBlocks
      .find((b) => b.blockName === "content")
      ?.modules.find((m) => m.moduleId === moduleId);
    expect(branchMod?.html).toBe("<div>branched html</div>");

    // A branch-less caller still sees the published html.
    const liveRead = await execute(registry, adapter, HUMAN, "pages.get_with_modules", { pageId });
    if (!liveRead.ok) throw new Error(`live read: ${JSON.stringify(liveRead.error)}`);
    const liveBlocks = (
      liveRead.value as {
        page: { blocks: { blockName: string; modules: { moduleId: string; html: string }[] }[] };
      }
    ).page.blocks;
    const liveMod = liveBlocks
      .find((b) => b.blockName === "content")
      ?.modules.find((m) => m.moduleId === moduleId);
    expect(liveMod?.html).toBe("<div>published html</div>");
  });

  it("pages.render_preview renders a branched-CREATED page when the branch arrives as INPUT (the /edit iframe shape)", async () => {
    // Run #8 live-edit CI regression: /edit/preview/<pageId>?branch=…
    // calls render_preview with the OPERATOR's ctx (no chatBranchId)
    // and the branch as input. Pre-fix, row visibility keyed off ctx
    // only, so a page CREATED on the branch was invisible and the
    // iframe (and the AI's screenshot capture riding on it) 404'd.
    const tpl = await execute(registry, adapter, HUMAN, "templates.create", {
      slug: `${TPL_SLUG}-pv`,
      displayName: "T-preview",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
    });
    if (!tpl.ok) throw new Error(`tpl-pv: ${JSON.stringify(tpl.error)}`);
    const templateId = (tpl.value as { templateId: string }).templateId;
    const blocks = await execute(registry, adapter, HUMAN, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    if (!blocks.ok) throw new Error(`blocks-pv: ${JSON.stringify(blocks.error)}`);

    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: `${SESSION_TITLE}-preview`,
    });
    if (!session.ok) throw new Error("session");
    const { chatBranchId } = session.value as { chatBranchId: string };

    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "run8-reads-pv-ai",
      chatBranchId,
    };

    // Branched CREATE — the pages row itself is tagged with the branch.
    const page = await execute(registry, adapter, aiCtx, "pages.create", {
      slug: `${PAGE_SLUG}-pv`,
      locale: "en",
      title: "Branched page",
      templateId,
      status: "draft",
    });
    if (!page.ok) throw new Error(`page-pv: ${JSON.stringify(page.error)}`);
    const pageId = (page.value as { pageId: string }).pageId;

    // The iframe shape: human ctx, branch as INPUT — must render.
    const withBranch = await execute(registry, adapter, HUMAN, "pages.render_preview", {
      pageId,
      chatBranchId,
    });
    if (!withBranch.ok) throw new Error(`preview-pv: ${JSON.stringify(withBranch.error)}`);
    expect((withBranch.value as { pageSlug: string }).pageSlug).toBe(`${PAGE_SLUG}-pv`);

    // Branch isolation stays: without ANY branch (ctx or input) the
    // branched-created page remains invisible.
    const withoutBranch = await execute(registry, adapter, HUMAN, "pages.render_preview", {
      pageId,
    });
    expect(withoutBranch.ok).toBe(false);
  });
});
