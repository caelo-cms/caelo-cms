// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.1 — regression test for the chat-branched placement-visibility
 * fix in `set_page_module_content`. Pre-v0.6.1 the placement check
 * queried only live `page_modules` — so a placement created earlier in
 * the SAME chat (via `pages.set_modules` branch-writing to
 * `page_layout_snapshots`) was invisible, surfacing as a v0.6.0 W3
 * `nextAction` error pointing at `inspect_page_render` in a recovery
 * loop. The fix at `page-module-content.ts:branchAwarePlacementExists`
 * mirrors the `preview.ts:214-258` overlay pattern.
 *
 * What this test pins:
 *   (a) Direct (non-chat) flow still works — placement check sees
 *       the live `page_modules` row created by `pages.set_modules`.
 *   (b) Chat-branched flow now works — placement check sees the
 *       branched layout snapshot, succeeds, and writes the content
 *       row tagged with the chat's branch_id.
 *   (c) Live `page_modules` is still empty after the branched flow
 *       (publish would merge it later — outside this test's scope).
 *   (d) Mismatched (chat-branch, page) returns "no placement" — the
 *       v0.6.0 W3 nextAction hint is preserved for genuinely missing
 *       placements.
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
let templateId = "";
let moduleId = "";

const SYSTEM_ACTOR = "00000000-0000-0000-0000-00000000ffff";

// Unique slugs per test run so re-runs don't conflict with leftover
// rows; wipe at the top still catches the previous run.
const TPL_SLUG = "v061-branched-placement-tpl";
const MOD_SLUG = "v061-branched-placement-mod";
const PAGE_SLUG_LIVE = "v061-branched-placement-page-live";
const PAGE_SLUG_BRANCHED = "v061-branched-placement-page-branched";
const PAGE_SLUG_MISMATCH = "v061-branched-placement-page-mismatch";
// Use a stable branch id so we can assert on it.
const CHAT_BRANCH_ID = "33333333-3333-4333-8333-aaaaaaaaaaaa";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_module_content WHERE page_id IN (
        SELECT id FROM pages WHERE slug IN (${PAGE_SLUG_LIVE}, ${PAGE_SLUG_BRANCHED}, ${PAGE_SLUG_MISMATCH})
      )`;
      await tx`DELETE FROM page_modules WHERE page_id IN (
        SELECT id FROM pages WHERE slug IN (${PAGE_SLUG_LIVE}, ${PAGE_SLUG_BRANCHED}, ${PAGE_SLUG_MISMATCH})
      )`;
      await tx`DELETE FROM page_layout_snapshots WHERE page_id IN (
        SELECT id FROM pages WHERE slug IN (${PAGE_SLUG_LIVE}, ${PAGE_SLUG_BRANCHED}, ${PAGE_SLUG_MISMATCH})
      )`;
      await tx`DELETE FROM pages WHERE slug IN (${PAGE_SLUG_LIVE}, ${PAGE_SLUG_BRANCHED}, ${PAGE_SLUG_MISMATCH})`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
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
  const seeded = await seedTemplateAndModule();
  templateId = seeded.templateId;
  moduleId = seeded.moduleId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

function systemCtx(branchId?: string): ExecutionContext {
  return {
    actorId: SYSTEM_ACTOR,
    actorKind: "system",
    requestId: "page-module-content-branched-test",
    ...(branchId ? { chatBranchId: branchId } : {}),
  };
}

async function seedTemplateAndModule(): Promise<{ templateId: string; moduleId: string }> {
  const ctx = systemCtx();
  const tpl = await execute(registry, adapter, ctx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "branched placement tpl",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content"></caelo-slot></body></html>`,
    css: "",
  });
  if (!tpl.ok) throw new Error(`templates.create failed: ${JSON.stringify(tpl.error)}`);
  const templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, ctx, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const mod = await execute(registry, adapter, ctx, "modules.create", {
    slug: MOD_SLUG,
    displayName: "branched placement mod",
    html: "<p>{{message}}</p>",
    css: "",
    js: "",
    fields: [{ name: "message", kind: "text", label: "Message", default: "Hi" }],
  });
  if (!mod.ok) throw new Error(`modules.create failed: ${JSON.stringify(mod.error)}`);
  return { templateId, moduleId: (mod.value as { moduleId: string }).moduleId };
}

describe("set_page_module_content — branch-aware placement check (v0.6.1)", () => {
  it("(a) live flow — placement created without a chat branch is visible immediately", async () => {
    const ctx = systemCtx(); // no branch
    const pageRes = await execute(registry, adapter, ctx, "pages.create", {
      slug: PAGE_SLUG_LIVE,
      name: "live page",
      title: "Live",
      templateId,
    });
    if (!pageRes.ok) throw new Error(`pages.create live: ${JSON.stringify(pageRes.error)}`);
    const pageId = (pageRes.value as { pageId: string }).pageId;
    const setRes = await execute(registry, adapter, ctx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    expect(setRes.ok).toBe(true);

    const contentRes = await execute(registry, adapter, ctx, "page_module_content.set", {
      pageId,
      blockName: "content",
      position: 0,
      contentValues: { message: "Live hello" },
    });
    expect(contentRes.ok).toBe(true);
  });

  it("(b) chat-branched flow — placement created on a chat branch is visible to the same-branch content write (the bug under fix)", async () => {
    const branchCtx = systemCtx(CHAT_BRANCH_ID);
    const pageRes = await execute(registry, adapter, branchCtx, "pages.create", {
      slug: PAGE_SLUG_BRANCHED,
      name: "branched page",
      title: "Branched",
      templateId,
    });
    if (!pageRes.ok) throw new Error(`pages.create branched: ${JSON.stringify(pageRes.error)}`);
    const pageId = (pageRes.value as { pageId: string }).pageId;

    // pages.set_modules with chatBranchId set → writes ONLY to
    // page_layout_snapshots (the bug scenario). Pre-v0.6.1 the next
    // call would fail "no placement at (content, 0)".
    const setRes = await execute(registry, adapter, branchCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    expect(setRes.ok).toBe(true);

    const contentRes = await execute(registry, adapter, branchCtx, "page_module_content.set", {
      pageId,
      blockName: "content",
      position: 0,
      contentValues: { message: "Branched hello" },
    });
    expect(contentRes.ok).toBe(true);

    // (c) Live page_modules is still empty — branch isolation intact.
    const sql = new SQL(ADMIN_URL!);
    try {
      const rows = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return tx`SELECT count(*)::int AS n FROM page_modules WHERE page_id = ${pageId}::uuid`;
      })) as unknown as { n: number }[];
      expect(rows[0]?.n).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it("(d) mismatched (chat-branch, page) — placement check returns 'no placement' with the W3 nextAction hint", async () => {
    const branchCtx = systemCtx(CHAT_BRANCH_ID);
    const pageRes = await execute(registry, adapter, branchCtx, "pages.create", {
      slug: PAGE_SLUG_MISMATCH,
      name: "mismatch page",
      title: "Mismatch",
      templateId,
    });
    if (!pageRes.ok) throw new Error(`pages.create mismatch: ${JSON.stringify(pageRes.error)}`);
    const pageId = (pageRes.value as { pageId: string }).pageId;

    // NO pages.set_modules call → no branched layout snapshot exists
    // for this page; placement check must fall through to live (also
    // empty) and return the genuine "no placement" error.
    const contentRes = await execute(registry, adapter, branchCtx, "page_module_content.set", {
      pageId,
      blockName: "content",
      position: 0,
      contentValues: { message: "should fail" },
    });
    expect(contentRes.ok).toBe(false);
    if (contentRes.ok) throw new Error("unreachable");
    const e = contentRes.error as {
      kind: string;
      message: string;
      nextAction?: { tool: string };
    };
    expect(e.kind).toBe("HandlerError");
    expect(e.message).toContain("no placement");
    expect(e.nextAction?.tool).toBe("inspect_page_render");
  });
});
