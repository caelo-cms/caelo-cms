// SPDX-License-Identifier: MPL-2.0

/**
 * #1156 — page SEO goes through Stage like page content:
 *
 *   - an SEO write in a chat lands on the chat's draft, not on `pages_seo`:
 *     the chat (and the editor) sees it with its pending fields, main and
 *     every build do not, and the chat's open changes list it as SEO;
 *   - a staging build refuses while the description is only pending, and
 *     passes once a Stage merged it;
 *   - "undo this chat" drops the SEO edit;
 *   - fill-once is decided on the chat's view: a chat's own autofill counts
 *     before its Stage;
 *   - a later page edit in the same chat keeps the pending SEO, and the
 *     merge writes both;
 *   - an SEO write outside a chat writes the live row AND a main snapshot,
 *     so a page revert restores the SEO.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const PFX = "t1156-";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "t1156" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId: string;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

interface Chat {
  id: string;
  ctx: ExecutionContext;
}

async function chat(title: string, isolation?: "experiment"): Promise<Chat> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    title: `${PFX}${title}`,
    ...(isolation ? { isolation } : {}),
  });
  return {
    id: v.chatSessionId,
    ctx: {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: `t1156-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

async function page(slug: string, status: "draft" | "published" = "published"): Promise<string> {
  return (
    await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}${slug}`,
      title: slug,
      templateId,
      status,
    })
  ).pageId;
}

interface SeoView {
  metaDescription: string;
  ogImageAssetId: string | null;
  noindex: boolean;
  autofilledAt: string | null;
  pendingFields: string[];
}

async function seo(ctx: ExecutionContext, pageId: string): Promise<SeoView | null> {
  return (await op<{ seo: SeoView | null }>(ctx, "pages_seo.get", { pageId })).seo;
}

async function liveDescription(pageId: string): Promise<string | null> {
  const rows = await withSql(
    (tx) =>
      tx`SELECT meta_description FROM pages_seo WHERE page_id = ${pageId}::uuid` as unknown as Promise<
        { meta_description: string }[]
      >,
  );
  return rows[0]?.meta_description ?? null;
}

async function pendingPages(
  chatSessionId: string,
): Promise<{ entityId: string; detail?: string }[]> {
  return (
    await op<{ pending: { pages: { kind: string; entityId: string; detail?: string }[] } }>(
      SYS,
      "chat.list_pending_changes",
      { chatSessionId },
    )
  ).pending.pages.filter((p) => p.kind === "page");
}

async function stagingBuild(): Promise<string> {
  const r = await execute(registry, adapter, SYS, "deploy.trigger", { targetName: "staging" });
  return r.ok ? "" : ((r.error as { message?: string }).message ?? r.error.kind);
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}tpl`}`;
    // Other suites' leftovers must not decide the build gate below.
    await tx`UPDATE pages SET status = 'draft' WHERE slug NOT LIKE ${`${PFX}%`}`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      pageType: "home",
      slug: `${PFX}tpl`,
      displayName: "SEO through Stage",
      html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("#1156 page SEO goes through Stage", () => {
  it("keeps a chat's SEO edit on the draft until a Stage merges it, and the build follows", async () => {
    const p = await page("pricing");
    const a = await chat("SEO pricing");

    await op(a.ctx, "pages_seo.autofill", {
      pageId: p,
      metaDescription: "Plans and prices for every team size.",
    });

    // The chat sees its edit, marked pending; main and the live row do not.
    expect(await seo(a.ctx, p)).toMatchObject({
      metaDescription: "Plans and prices for every team size.",
      pendingFields: ["metaDescription"],
    });
    expect(await seo(SYS, p)).toBeNull();
    expect(await liveDescription(p)).toBeNull();
    const pending = await pendingPages(a.id);
    expect(pending.map((x) => x.entityId)).toEqual([p]);
    expect(pending[0]?.detail).toContain("· SEO");

    // A build reads main: the description is not there yet.
    expect(await stagingBuild()).toContain(`pageId ${p}`);
    // The chat's own readiness view counts its pending description; main's
    // still misses it.
    const readiness = async (ctx: ExecutionContext) =>
      JSON.stringify(await op<unknown>(ctx, "deploy.stage_readiness", {}));
    expect(await readiness(SYS)).toContain(p);
    expect(await readiness(a.ctx)).not.toContain(p);

    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [a.id] });
    expect(await liveDescription(p)).toBe("Plans and prices for every team size.");
    expect(await seo(SYS, p)).toMatchObject({ pendingFields: [] });
    expect(await pendingPages(a.id)).toEqual([]);
    expect(await stagingBuild()).not.toContain("meta description");
  });

  it("drops the SEO edit when the chat is undone", async () => {
    const p = await page("about");
    await op(SYS, "pages_seo.set", { pageId: p, metaDescription: "Who we are." });
    const a = await chat("SEO about");
    await op(a.ctx, "pages_seo.set", { pageId: p, metaDescription: "Rewritten.", noindex: true });
    expect(await seo(a.ctx, p)).toMatchObject({
      metaDescription: "Rewritten.",
      noindex: true,
      pendingFields: ["metaDescription", "noindex"],
    });

    const undone = await op<{ applied: boolean }>(SYS, "chat.undo_changes", {
      chatSessionId: a.id,
    });
    expect(undone.applied).toBe(true);
    expect(await seo(a.ctx, p)).toMatchObject({
      metaDescription: "Who we are.",
      noindex: false,
      pendingFields: [],
    });
    expect(await liveDescription(p)).toBe("Who we are.");
    expect(await pendingPages(a.id)).toEqual([]);
  });

  it("decides fill-once on the chat's view", async () => {
    const p = await page("contact");
    const a = await chat("SEO contact");
    await op(a.ctx, "pages_seo.autofill_many", {
      items: [{ pageId: p, metaDescription: "Talk to us." }],
    });
    const again = await execute(registry, adapter, a.ctx, "pages_seo.autofill", {
      pageId: p,
      metaDescription: "Something else.",
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(JSON.stringify(again.error)).toContain("AlreadyAutofilled");
    // The same text again is a no-op, not a refusal.
    expect(
      await op<{ alreadyFilled: boolean }>(a.ctx, "pages_seo.autofill", {
        pageId: p,
        metaDescription: "Talk to us.",
      }),
    ).toEqual({ alreadyFilled: true });
    // Main never saw the first fill: an autofill outside the chat still may.
    expect((await seo(SYS, p))?.autofilledAt ?? null).toBeNull();
  });

  it("keeps the pending SEO through a later page edit and merges both", async () => {
    const p = await page("team");
    const a = await chat("SEO team");
    await op(a.ctx, "pages_seo.optimize", { pageId: p, metaDescription: "The team behind it." });
    await op(a.ctx, "pages.update", { pageId: p, title: "Our team" });
    expect((await seo(a.ctx, p))?.metaDescription).toBe("The team behind it.");

    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [a.id] });
    expect(await liveDescription(p)).toBe("The team behind it.");
    const title = await withSql(
      (tx) =>
        tx`SELECT title FROM pages WHERE id = ${p}::uuid` as unknown as Promise<
          { title: string }[]
        >,
    );
    expect(title[0]?.title).toBe("Our team");
  });

  it("snapshots an SEO write outside a chat, so a page revert restores it", async () => {
    const p = await page("jobs");
    await op(SYS, "pages_seo.set", { pageId: p, metaDescription: "We are hiring." });
    const snaps = await withSql(
      (tx) =>
        tx`SELECT ss.id::text AS id, ss.chat_branch_id, ps.state->'seo'->>'metaDescription' AS d
           FROM site_snapshots ss JOIN page_snapshots ps ON ps.site_snapshot_id = ss.id
           WHERE ps.page_id = ${p}::uuid AND ss.op_kind = 'pages_seo.set'` as unknown as Promise<
          { id: string; chat_branch_id: string | null; d: string }[]
        >,
    );
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ chat_branch_id: null, d: "We are hiring." });

    await op(SYS, "pages_seo.set", { pageId: p, metaDescription: "No openings." });
    await op({ ...SYS, actorKind: "human" }, "snapshots.revert_page", {
      pageId: p,
      snapshotId: snaps[0]?.id,
    });
    expect(await liveDescription(p)).toBe("We are hiring.");
  });

  it("refuses an SEO write for a page that does not exist", async () => {
    const r = await execute(registry, adapter, SYS, "pages_seo.set", {
      pageId: "00000000-0000-4000-8000-000000000001",
      metaDescription: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("list_pages");
  });
  it("keeps an SEO write made outside the chat when the chat's title edit is staged", async () => {
    const p = await page("blog");
    await op(SYS, "pages_seo.set", { pageId: p, metaDescription: "Old text." });
    const a = await chat("Title only");
    await op(a.ctx, "pages.update", { pageId: p, title: "Our blog" });
    // The panel saves a new description meanwhile (outside any chat).
    await op(SYS, "pages_seo.set", { pageId: p, metaDescription: "Panel text." });
    expect((await seo(a.ctx, p))?.metaDescription).toBe("Panel text.");

    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [a.id] });
    expect(await liveDescription(p)).toBe("Panel text.");
  });

  it("applies repeated pages of one bulk optimize in input order", async () => {
    const p = await page("faq");
    const a = await chat("Bulk twice");
    await op(a.ctx, "pages_seo.optimize_many", {
      updates: [
        { pageId: p, metaDescription: "First.", ogImageAssetId: null },
        { pageId: p, metaDescription: "Second." },
      ],
    });
    expect((await seo(a.ctx, p))?.metaDescription).toBe("Second.");
    const entities = await withSql(
      (tx) =>
        tx`SELECT count(*)::int AS n FROM page_snapshots ps JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
           WHERE ps.page_id = ${p}::uuid AND ss.op_kind = 'pages_seo.optimize'` as unknown as Promise<
          { n: number }[]
        >,
    );
    expect(entities[0]?.n).toBe(1);
  });

  it("takes nothing over from another chat when an SEO write is refused", async () => {
    const p = await page("press");
    const exp = await chat("Holds press", "experiment");
    await op(exp.ctx, "pages.update", { pageId: p, title: "Press room" });
    const d = await chat("Bulk with a bad id");
    const r = await execute(registry, adapter, d.ctx, "pages_seo.optimize_many", {
      updates: [
        { pageId: p, metaDescription: "Press." },
        { pageId: "00000000-0000-4000-8000-000000000002", metaDescription: "x" },
      ],
    });
    expect(r.ok).toBe(false);
    // The experiment still owns its change: the failed batch rolled back.
    expect((await pendingPages(exp.id)).map((x) => x.entityId)).toEqual([p]);
    expect(await pendingPages(d.id)).toEqual([]);
  });
  it("takes nothing over when autofill refuses (or no-ops on) an already-filled page", async () => {
    const p = await page("careers");
    await op(SYS, "pages_seo.autofill", { pageId: p, metaDescription: "Join us." });
    const exp = await chat("Holds careers", "experiment");
    await op(exp.ctx, "pages.update", { pageId: p, title: "Careers" });
    const d = await chat("Autofill again");
    const refused = await execute(registry, adapter, d.ctx, "pages_seo.autofill", {
      pageId: p,
      metaDescription: "Something else.",
    });
    expect(refused.ok).toBe(false);
    expect(
      await op<{ alreadyFilled: boolean }>(d.ctx, "pages_seo.autofill", {
        pageId: p,
        metaDescription: "Join us.",
      }),
    ).toEqual({ alreadyFilled: true });
    // Neither call took the experiment's pending change over.
    expect((await pendingPages(exp.id)).map((x) => x.entityId)).toEqual([p]);
    expect(await pendingPages(d.id)).toEqual([]);
  });
  it("serializes SEO writes outside a chat, so concurrent field writes compose", async () => {
    const p = await page("concurrent");
    for (let round = 0; round < 5; round++) {
      await op(SYS, "pages_seo.set", { pageId: p, noindex: false, metaDescription: "base" });
      await Promise.all([
        op(SYS, "pages_seo.set", { pageId: p, noindex: true }),
        op(SYS, "pages_seo.optimize", { pageId: p, metaDescription: `optimized ${round}` }),
      ]);
      expect(await seo(SYS, p)).toMatchObject({
        noindex: true,
        metaDescription: `optimized ${round}`,
      });
    }
  });

  it("refuses an OG image that is not a library image, in a chat and outside one", async () => {
    const p = await page("og");
    const a = await chat("OG image");
    const missing = "00000000-0000-4000-8000-0000000000aa";
    for (const ctx of [a.ctx, SYS]) {
      const r = await execute(registry, adapter, ctx, "pages_seo.set", {
        pageId: p,
        ogImageAssetId: missing,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(JSON.stringify(r.error)).toContain("find_media");
    }
    expect(await pendingPages(a.id)).toEqual([]);
    expect(await seo(a.ctx, p)).toBeNull();
  });
  it("lets a bulk write refused on a draft conflict go through after the instructed re-read", async () => {
    const p = await page("conflict");
    const a = await chat("Writes first");
    const b = await chat("Writes second");
    await op(a.ctx, "pages_seo.set", { pageId: p, metaDescription: "From A." });
    const batch = { updates: [{ pageId: p, metaDescription: "From B." }] };
    const first = await execute(registry, adapter, b.ctx, "pages_seo.optimize_many", batch);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(JSON.stringify(first.error)).toContain("Conflict");
    // The re-read the conflict asks for records that B has seen A's change.
    await op(b.ctx, "pages_seo.get_many", { pageIds: [p] });
    await op(b.ctx, "pages_seo.optimize_many", batch);
    expect((await seo(b.ctx, p))?.metaDescription).toBe("From B.");
  });

  it("finds a page's SEO under an uppercase page id instead of building on defaults", async () => {
    const p = await page("upper");
    await op(SYS, "pages_seo.set", {
      pageId: p,
      metaDescription: "Old.",
      noindex: true,
      canonicalUrl: "https://example.com/upper",
    });
    await op(SYS, "pages_seo.set", { pageId: p.toUpperCase(), metaDescription: "New." });
    expect(await seo(SYS, p.toUpperCase())).toMatchObject({
      metaDescription: "New.",
      noindex: true,
    });
    expect((await seo(SYS, p))?.noindex).toBe(true);
  });
  it("accepts an uppercase OG image id and stores it canonically", async () => {
    const p = await page("og-upper");
    const sha = `${Date.now().toString(16).padStart(16, "0")}`.repeat(4).slice(0, 64);
    const up = await op<{ assetId: string }>(SYS, "media.upload", {
      sha256: sha,
      originalName: "t1156-og.png",
      mime: "image/png",
      sizeBytes: 10,
      width: 1200,
      height: 630,
      alt: "og",
      storageKey: `t1156/${sha}.png`,
      variants: [
        {
          variant: "original",
          format: "png",
          width: 1200,
          height: 630,
          sizeBytes: 10,
          storageKey: `t1156/${sha}.png`,
        },
      ],
    });
    const a = await chat("OG upper");
    for (const ctx of [a.ctx, SYS]) {
      await op(ctx, "pages_seo.set", { pageId: p, ogImageAssetId: up.assetId.toUpperCase() });
    }
    const chatView = await seo(a.ctx, p);
    expect(chatView?.ogImageAssetId).toBe(up.assetId);
    // Main holds the same image now: the chat's (canonical) id is not "pending".
    expect(chatView?.pendingFields).toEqual([]);
  });
});
