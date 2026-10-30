// SPDX-License-Identifier: MPL-2.0

/**
 * #1276 — every page has a chosen page type, against a real Postgres:
 *
 *   - every create path (pages.create, build_page, pages.duplicate,
 *     imports.accept_page) refuses a create without a type (or a template
 *     of exactly one type), and the error lists the types;
 *   - templates.create needs pageType or newPageType; newPageType creates
 *     the type with the template as its default in one transaction;
 *   - the duplicate guard: `blogs` next to `blog` refused, `distinctFrom`
 *     passes, `news` next to `new` only hinted, duplicates within one batch
 *     caught;
 *   - `page_type_confirmed`: a write naming pageType confirms (also the
 *     current type), the flag rides the branch snapshot through merge,
 *     revert and duplicate, and the structure check reports the rest;
 *   - a type nobody uses is deletable (no "site default" refusal).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { unconfirmedPageTypeFindings } from "../quality/checks/structure-page-type.js";
import { structureSourcesFromOps } from "../quality/checks/structure-sources.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const PFX = "t1276-";
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "t1276" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  // Templates and page types are seed-bearing (kept across files by the
  // test reset): drop what an earlier run of this file left behind.
  await asSystem(async (tx) => {
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_types WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
    await tx`
      UPDATE page_types pt SET definition = jsonb_set(pt.definition, '{templates}', (
        SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM jsonb_array_elements(pt.definition->'templates') t
        WHERE EXISTS (SELECT 1 FROM templates x WHERE x.id::text = t #>> '{}')))`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function fail(ctx: ExecutionContext, name: string, input: unknown): Promise<string> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (r.ok) throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(r.value)}`);
  return "message" in r.error ? r.error.message : JSON.stringify(r.error);
}

async function chat(title: string): Promise<ExecutionContext> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    title: `${PFX}${title}`,
  });
  return {
    actorId: SYSTEM_ID,
    actorKind: "ai",
    requestId: `t1276-${title}`,
    chatBranchId: v.chatBranchId,
    chatTaskId: v.chatSessionId,
  };
}

const HTML = '<main><caelo-slot name="content"></caelo-slot></main>';

/** A new page type with its first template, via templates.create newPageType. */
async function typeWithTemplate(slug: string): Promise<{ templateId: string; slug: string }> {
  const typeSlug = `${PFX}${slug}`;
  const { templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
    slug: `${PFX}${slug}-tpl`,
    displayName: `${slug} template`,
    html: HTML,
    newPageType: {
      slug: typeSlug,
      name: slug,
      purpose: `${slug} pages of the test site`,
      collection: true,
    },
  });
  return { templateId, slug: typeSlug };
}

async function confirmedOf(pageId: string): Promise<boolean> {
  const rows = await asSystem(
    (tx) => tx`SELECT page_type_confirmed AS c FROM pages WHERE id = ${pageId}::uuid`,
  );
  return (rows as unknown as { c: boolean }[])[0]?.c ?? false;
}

describe("#1276 the page type is a decision on every create path", () => {
  it("pages.create and build_page refuse a create without a type, listing the types", async () => {
    const news = await typeWithTemplate("news");
    const refused = await fail(SYS, "pages.create", { slug: `${PFX}none`, title: "None" });
    expect(refused).toContain("pageType is required");
    expect(refused).toContain(`"${news.slug}" (news pages of the test site; 0 page(s))`);
    expect(refused).toContain("create_template with newPageType");

    const unknown = await fail(SYS, "pages.create", {
      slug: `${PFX}none`,
      title: "None",
      pageType: `${PFX}no-such`,
    });
    expect(unknown).toContain(`no page type "${PFX}no-such"`);
    expect(unknown).toContain(`"${news.slug}"`);

    const built = await fail(SYS, "pages.build_page", {
      page: { slug: `${PFX}none`, title: "None" },
      modules: [],
    });
    expect(built).toContain("pageType is required");

    // A template of exactly one type is a deterministic choice: allowed.
    const viaTemplate = await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}via-tpl`,
      title: "Via template",
      templateId: news.templateId,
    });
    const got = await op<{ page: { pageType: string; pageTypeConfirmed: boolean } }>(
      SYS,
      "pages.get",
      { pageId: viaTemplate.pageId },
    );
    expect(got.page.pageType).toBe(news.slug);
    expect(got.page.pageTypeConfirmed).toBe(true);
  });

  it("imports.accept_page names the type; duplicate keeps it or takes a new one", async () => {
    const doc = await typeWithTemplate("doc");
    const guide = await typeWithTemplate("guide");
    const source = await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}dup-src`,
      title: "Source",
      pageType: doc.slug,
    });
    const copy = await op<{ pageId: string }>(SYS, "pages.duplicate", {
      sourcePageId: source.pageId,
      newSlug: `${PFX}dup-copy`,
    });
    expect(
      (await op<{ page: { pageType: string } }>(SYS, "pages.get", { pageId: copy.pageId })).page
        .pageType,
    ).toBe(doc.slug);
    const retyped = await op<{ pageId: string }>(SYS, "pages.duplicate", {
      sourcePageId: source.pageId,
      newSlug: `${PFX}dup-retyped`,
      targetTemplateId: guide.templateId,
      pageType: guide.slug,
    });
    expect(
      (await op<{ page: { pageType: string } }>(SYS, "pages.get", { pageId: retyped.pageId })).page
        .pageType,
    ).toBe(guide.slug);

    const importInput = await asSystem(async (tx) => {
      const run = (await tx`
        INSERT INTO import_runs (source_url, proposed_by, status)
        VALUES ('https://example.test/t1276', ${SYSTEM_ID}::uuid, 'ready_for_review')
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      const row = (await tx`
        INSERT INTO import_pages (run_id, source_url, proposed_slug, proposed_title, proposed_modules)
        VALUES (${run[0]?.id}::uuid, 'https://example.test/t1276/a', ${`${PFX}imported`}, 'Imported',
                '[]'::jsonb)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      return { runId: run[0]?.id ?? "", importPageId: row[0]?.id ?? "" };
    });
    try {
      const noType = await fail(SYS, "imports.accept_page", {
        importPageId: importInput.importPageId,
      });
      expect(noType).toContain("pageType is required");
      const accepted = await op<{ pageId: string }>(SYS, "imports.accept_page", {
        importPageId: importInput.importPageId,
        pageType: doc.slug,
      });
      expect(
        (await op<{ page: { pageType: string } }>(SYS, "pages.get", { pageId: accepted.pageId }))
          .page.pageType,
      ).toBe(doc.slug);
    } finally {
      await asSystem(async (tx) => {
        await tx`DELETE FROM import_pages WHERE run_id = ${importInput.runId}::uuid`;
        await tx`DELETE FROM import_runs WHERE id = ${importInput.runId}::uuid`;
      });
    }
  });
});

describe("#1276 templates.create names its page type", () => {
  it("refuses neither and both; newPageType creates type + template in one call", async () => {
    const neither = await fail(SYS, "templates.create", {
      slug: `${PFX}orphan-tpl`,
      displayName: "Orphan",
      html: HTML,
    });
    expect(neither).toContain("pass pageType");
    expect(neither).toContain("newPageType");

    const both = await fail(SYS, "templates.create", {
      slug: `${PFX}both-tpl`,
      displayName: "Both",
      html: HTML,
      pageType: "home",
      newPageType: { slug: `${PFX}both`, name: "Both", purpose: "Both", collection: false },
    });
    expect(both).toContain("only one of");

    const job = await typeWithTemplate("job");
    const list = await op<{
      pageTypes: { slug: string; templates: string[]; defaultTemplate: string }[];
    }>(SYS, "page_types.list", {});
    const t = list.pageTypes.find((x) => x.slug === job.slug);
    expect(t?.templates).toEqual([job.templateId]);
    expect(t?.defaultTemplate).toBe(job.templateId);

    // An existing slug would replace that type's templates: refused, nothing written.
    const taken = await fail(SYS, "templates.create", {
      slug: `${PFX}job-tpl-2`,
      displayName: "Job 2",
      html: HTML,
      newPageType: { slug: job.slug, name: "Job", purpose: "Jobs", collection: true },
    });
    expect(taken).toContain(`pass pageType:"${job.slug}"`);
    const after = await op<{ pageTypes: { slug: string; templates: string[] }[] }>(
      SYS,
      "page_types.list",
      {},
    );
    expect(after.pageTypes.find((x) => x.slug === job.slug)?.templates).toEqual([job.templateId]);
  });
});

describe("#1276 duplicate guard on page_types.upsert_many", () => {
  it("refuses blogs next to blog unless distinctFrom; hints news next to new; catches the batch", async () => {
    const blog = await typeWithTemplate("blog");
    const def = (slug: string) => ({
      slug,
      name: slug,
      purpose: `${slug} test pages`,
      collection: false,
      templates: [blog.templateId],
      defaultTemplate: blog.templateId,
    });
    const refused = await fail(SYS, "page_types.upsert_many", {
      pageTypes: [def(`${PFX}blogs`)],
    });
    expect(refused).toContain(`same kind of content as "${blog.slug}"`);
    expect(refused).toContain(`distinctFrom:["${blog.slug}"]`);

    const viaTemplate = await fail(SYS, "templates.create", {
      slug: `${PFX}blog-post-tpl`,
      displayName: "Blog post",
      html: HTML,
      newPageType: {
        slug: `${PFX}blog-post`,
        name: "Blog post",
        purpose: "Posts",
        collection: true,
      },
    });
    expect(viaTemplate).toContain(`same kind of content as "${blog.slug}"`);

    const passed = await op<{ pageTypes: { slug: string; created: boolean }[] }>(
      SYS,
      "page_types.upsert_many",
      { pageTypes: [{ ...def(`${PFX}blogs`), distinctFrom: [blog.slug] }] },
    );
    expect(passed.pageTypes[0]?.created).toBe(true);
    // Updating an existing type never re-runs the guard.
    await op(SYS, "page_types.upsert_many", { pageTypes: [def(`${PFX}blogs`)] });

    await op(SYS, "page_types.upsert_many", { pageTypes: [def(`${PFX}faq`)] });
    const hinted = await op<{ pageTypes: { created: boolean }[]; hints?: string[] }>(
      SYS,
      "page_types.upsert_many",
      { pageTypes: [def(`${PFX}fab`)] },
    );
    expect(hinted.pageTypes[0]?.created).toBe(true);
    expect((hinted.hints ?? []).join(" ")).toContain(`"${PFX}faq"`);
    // `news` next to `new` (the first test made t1276-news) is a hint, never a refusal.
    const newer = await op<{ pageTypes: { created: boolean }[]; hints?: string[] }>(
      SYS,
      "page_types.upsert_many",
      { pageTypes: [def(`${PFX}new`)] },
    );
    expect(newer.pageTypes[0]?.created).toBe(true);
    expect((newer.hints ?? []).join(" ")).toContain(`"${PFX}news"`);

    const batch = await fail(SYS, "page_types.upsert_many", {
      pageTypes: [def(`${PFX}event`), def(`${PFX}events`)],
    });
    expect(batch).toContain(`same kind of content as "${PFX}events"`);
    const none = await op<{ pageTypes: { slug: string }[] }>(SYS, "page_types.list", {
      query: `${PFX}event`,
    });
    expect(none.pageTypes).toEqual([]);
  });
});

describe("#1276 page_type_confirmed", () => {
  it("a write naming pageType confirms; the flag rides branch, merge, revert and duplicate", async () => {
    const plain = await typeWithTemplate("plain");
    const created = await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}legacy`,
      title: "Legacy",
      pageType: plain.slug,
    });
    // A page that sat on the old stored default type (what 0443 marks).
    await asSystem(
      (tx) => tx`UPDATE pages SET page_type_confirmed = false WHERE id = ${created.pageId}::uuid`,
    );
    expect(await confirmedOf(created.pageId)).toBe(false);

    // An edit that does not name the type keeps the flag; a duplicate inherits it.
    await op(SYS, "pages.update", { pageId: created.pageId, title: "Legacy 2" });
    expect(await confirmedOf(created.pageId)).toBe(false);
    const copy = await op<{ pageId: string }>(SYS, "pages.duplicate", {
      sourcePageId: created.pageId,
      newSlug: `${PFX}legacy-copy`,
    });
    expect(await confirmedOf(copy.pageId)).toBe(false);

    // The structure check reports the unconfirmed pages (Stage warning).
    const index = await structureSourcesFromOps(registry, adapter, SYS).pageIndex();
    const finding = unconfirmedPageTypeFindings(index)[0];
    expect(finding?.ruleId).toBe("structure/unconfirmed-page-type");
    expect(finding?.message).toContain(`/${PFX}legacy`);

    // In a chat: naming the CURRENT type confirms, on the branch only.
    const ctx = await chat("confirm");
    await op(ctx, "pages.update_many", {
      updates: [{ pageId: created.pageId, pageType: plain.slug }],
    });
    expect(await confirmedOf(created.pageId)).toBe(false);
    const inChat = await op<{ page: { pageTypeConfirmed: boolean } }>(ctx, "pages.get", {
      pageId: created.pageId,
    });
    expect(inChat.page.pageTypeConfirmed).toBe(true);
    // The Stage merge writes it to the live row.
    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [ctx.chatTaskId] });
    expect(await confirmedOf(created.pageId)).toBe(true);

    // revert_page to a snapshot from before the confirmation restores false.
    const snaps = await asSystem(
      (tx) => tx`
        SELECT ps.site_snapshot_id::text AS id, ps.state->>'pageTypeConfirmed' AS c
        FROM page_snapshots ps JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
        WHERE ps.page_id = ${created.pageId}::uuid
        ORDER BY ss.created_at`,
    );
    const before = (snaps as unknown as { id: string; c: string }[]).find((s) => s.c === "false");
    expect(before).toBeDefined();
    await op(SYS, "snapshots.revert_page", { pageId: created.pageId, snapshotId: before?.id });
    expect(await confirmedOf(created.pageId)).toBe(false);
  });

  it("a page type no page uses is deletable (there is no site default to protect)", async () => {
    const lone = await typeWithTemplate("lone");
    const r = await op<{ deleted: string[] }>(SYS, "page_types.delete_many", {
      slugs: [lone.slug],
    });
    expect(r.deleted).toEqual([lone.slug]);
  });
});
