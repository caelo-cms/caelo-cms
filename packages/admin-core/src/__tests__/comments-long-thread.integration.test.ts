// SPDX-License-Identifier: MPL-2.0

/**
 * #1169 — no approved comment may fall between the bake and the feed.
 *
 * The plugin baked the 200 oldest comments while the feed returned only what
 * was archived after the bake, so a comment past the 200th was in neither.
 * Here the real plugin reads a long thread through the real operations: the
 * admin's over `comment_archive` for the bake, the gateway's over the
 * published `published_comments` for the visitor. Whatever the count, the
 * bake, the comments after it and the pages below it must add up to the
 * whole thread, each comment once.
 *
 * The rows share timestamps on purpose: a page break inside one microsecond
 * must neither skip nor repeat a comment.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import commentsPlugin from "@caelo-cms/plugin-comments";
import { commentArchiveListForPageOp, registerGatewayOperations } from "@caelo-cms/plugin-host";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { commentArchiveStatsManyOp } from "../ops/plugins/comment_archive.js";
import { drainProjectionOnce, stagingPublicAdapter } from "../public-projection.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const STAGING_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL || !STAGING_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const P = "t1169";
const THREAD_LENGTH = 230;
const PAGE_SIZE = 50;

let adapter: DatabaseAdapter;
let staging: DatabaseAdapter;
let pageId = "";

async function admin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const conn = new SQL(ADMIN_URL as string);
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await conn.end();
  }
}

/** A plugin context whose `ctx.cms.call` runs the registry's operations for real. */
function contextOver(registry: OperationRegistry): PluginContextTier1 {
  return {
    cms: {
      call: async (name: string, input: unknown) => {
        const r = await execute(
          registry,
          adapter,
          { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: P },
          name,
          input,
        );
        if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
        return r.value;
      },
    },
  } as unknown as PluginContextTier1;
}

function adminCtx(): PluginContextTier1 {
  const registry = new OperationRegistry();
  registry.register(commentArchiveListForPageOp);
  registry.register(commentArchiveStatsManyOp);
  return contextOver(registry);
}

function gatewayCtx(): PluginContextTier1 {
  const registry = new OperationRegistry();
  registerGatewayOperations(registry);
  return contextOver(registry);
}

interface VisitorPage {
  comments: { id: string; author_name: string }[];
  nextCursor: { archivedAt: string; id: string } | null;
}

function listApproved(ctx: PluginContextTier1, args: Record<string, unknown>) {
  const op = commentsPlugin.operations.list_approved;
  if (!op) throw new Error("list_approved missing");
  return op(ctx, { pageId, ...args }) as Promise<VisitorPage>;
}

function bake(): Promise<string> {
  const render = commentsPlugin.staticRender;
  if (!render) throw new Error("staticRender missing");
  return render(adminCtx(), { pageId, pageUrlStyle: "directory", lang: "en" }) as Promise<string>;
}

function signature(): Promise<string> {
  const sign = commentsPlugin.metaSignature;
  if (!sign) throw new Error("metaSignature missing");
  return sign(adminCtx(), { pageId }) as Promise<string>;
}

async function approve(author: string): Promise<void> {
  await admin(async (tx) => {
    await tx`
      INSERT INTO comment_archive (public_row_id, page_id, author_name, content, status, submitted_at)
      VALUES (gen_random_uuid(), ${pageId}::uuid, ${author}, 'late', 'approved', now())`;
  });
  await drainProjectionOnce(adapter, staging);
}

async function dropComment(author: string): Promise<void> {
  await admin(async (tx) => {
    await tx`DELETE FROM comment_archive WHERE page_id = ${pageId}::uuid AND author_name = ${author}`;
  });
  await drainProjectionOnce(adapter, staging);
}

const expectedAuthors = () => Array.from({ length: THREAD_LENGTH }, (_, i) => `Author ${i + 1}`);

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  staging = stagingPublicAdapter(STAGING_URL);
  pageId = await admin(async (tx) => {
    const [tpl] = (await tx`
      SELECT t.id::text AS id FROM templates t
       WHERE t.deleted_at IS NULL
         AND (SELECT count(*) FROM page_types pt
               WHERE pt.deleted_at IS NULL AND pt.chat_branch_id IS NULL
                 AND pt.definition->'templates' ? t.id::text) = 1
       ORDER BY t.slug LIMIT 1`) as { id: string }[];
    const [page] = (await tx`
      INSERT INTO pages (slug, title, template_id, current_path, page_type_confirmed)
      VALUES (${`${P}-page`}, 'P', ${tpl?.id}::uuid, ${`/${P}-page`}, true)
      RETURNING id::text AS id`) as { id: string }[];
    // Every ten rows share an instant, and it has microseconds.
    await tx`
      INSERT INTO comment_archive
        (public_row_id, page_id, author_name, content, status, submitted_at, archived_at)
      SELECT gen_random_uuid(), ${page?.id}::uuid, 'Author ' || n, 'Comment ' || n, 'approved',
             t, t
      FROM generate_series(1, ${THREAD_LENGTH}) n,
           LATERAL (SELECT TIMESTAMPTZ '2026-01-01 00:00:00.123456+00'
                           + make_interval(mins => n / 10)) AS at (t)`;
    return page?.id ?? "";
  });
  await drainProjectionOnce(adapter, staging);
});

afterAll(async () => {
  await admin(async (tx) => {
    await tx`DELETE FROM comment_archive WHERE page_id = ${pageId}::uuid`;
    await tx`DELETE FROM pages WHERE id = ${pageId}::uuid`;
  });
  await drainProjectionOnce(adapter, staging);
  await adapter.close();
  await staging.close();
});

describe("a thread longer than the bake (#1169)", () => {
  it("bakes the newest comments and says how many exist", async () => {
    const html = await bake();
    expect([...html.matchAll(/<article /g)]).toHaveLength(PAGE_SIZE);
    expect(html).toContain(`data-total="${THREAD_LENGTH}"`);
    expect(html).toContain(`<span class="comment-author">Author ${THREAD_LENGTH}</span>`);
    expect(html).not.toContain('<span class="comment-author">Author 1</span>');
  });

  it("the bake plus the visitor's pages hold every approved comment, each once", async () => {
    const html = await bake();
    const reached = [...html.matchAll(/<span class="comment-author">(Author \d+)<\/span>/g)].map(
      (m) => m[1] as string,
    );
    const line = /data-cursor="([^"]+)"/.exec(html)?.[1]?.replaceAll("&quot;", '"');
    let before = line ? (JSON.parse(line) as VisitorPage["nextCursor"]) : null;
    expect(before).not.toBeNull();
    while (before) {
      const page = await listApproved(gatewayCtx(), { before });
      expect(page.comments.length).toBeLessThanOrEqual(PAGE_SIZE);
      reached.push(...page.comments.map((c) => c.author_name));
      before = page.nextCursor;
    }
    expect(reached).toHaveLength(THREAD_LENGTH);
    expect([...reached].sort()).toEqual(expectedAuthors().sort());
  });

  it("the admin's twin pages the same thread in the same order", async () => {
    const walk = async (ctx: PluginContextTier1) => {
      const ids: string[] = [];
      let before: VisitorPage["nextCursor"] = null;
      do {
        const page: VisitorPage = await listApproved(ctx, before ? { before } : {});
        ids.push(...page.comments.map((c) => c.id));
        before = page.nextCursor;
      } while (before);
      return ids;
    };
    const published = await walk(gatewayCtx());
    expect(published).toHaveLength(THREAD_LENGTH);
    expect(await walk(adminCtx())).toEqual(published);
  });

  it("a comment approved after the bake is in the feed, not lost above it", async () => {
    const bakedAt = new Date().toISOString();
    await approve("Late");
    const page = await listApproved(gatewayCtx(), { since: bakedAt });
    expect(page.comments.map((c) => c.author_name)).toEqual(["Late"]);
    expect(page.nextCursor).toBeNull();
    await dropComment("Late");
  });
});

describe("a visitor's comment answers nobody (#1529)", () => {
  // An approved comment a version before 1.3.0 stored as a reply.
  const LEGACY_REPLY = "aaaaaaaa-0000-4000-8000-000000000007";
  const inserted: Record<string, unknown>[] = [];

  /** `submit` as the gateway runs it, its inbox insert recorded. */
  function submit(args: Record<string, unknown>) {
    const op = commentsPlugin.operations.submit;
    if (!op) throw new Error("submit missing");
    const ctx = {
      ...gatewayCtx(),
      query: {
        insert: async (_table: string, row: Record<string, unknown>) => {
          inserted.push(row);
          return { id: "new" };
        },
      },
    } as unknown as PluginContextTier1;
    return Promise.resolve(op(ctx, args));
  }

  beforeAll(async () => {
    await admin(async (tx) => {
      await tx`
        INSERT INTO comment_archive
          (public_row_id, page_id, parent_id, author_name, content, status, submitted_at)
        SELECT ${LEGACY_REPLY}::uuid, ${pageId}::uuid, id, 'Earlier reply', 'r', 'approved', now()
        FROM comment_archive WHERE page_id = ${pageId}::uuid LIMIT 1`;
    });
    await drainProjectionOnce(adapter, staging);
  });

  afterAll(async () => {
    await admin(async (tx) => {
      await tx`DELETE FROM comment_archive WHERE public_row_id = ${LEGACY_REPLY}::uuid`;
    });
    await drainProjectionOnce(adapter, staging);
  });

  it("refuses a parent at the declared contract, so no handler ever sees one", async () => {
    const contract = commentsPlugin.publicOperations?.find((o) => o.name === "submit")?.input;
    const comment = { pageId, authorName: "Eve", content: "Reply" };
    expect(contract?.safeParse(comment).success).toBe(true);
    expect(contract?.safeParse({ ...comment, parentId: LEGACY_REPLY }).success).toBe(false);
    expect(contract?.safeParse({ ...comment, parentId: null }).success).toBe(false);
    await expect(submit({ ...comment, parentId: LEGACY_REPLY })).rejects.toThrow();
    expect(inserted).toEqual([]);
  });

  it("stores a top-level comment, naming no parent", async () => {
    await expect(submit({ pageId, authorName: "Eve", content: "Hello" })).resolves.toMatchObject({
      status: "pending",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).not.toHaveProperty("parent_id");
  });

  it("keeps a stored parent and shows that comment as one of the thread", async () => {
    const page = await listApproved(gatewayCtx(), {});
    const shown = page.comments.find((c) => c.id === LEGACY_REPLY);
    expect(shown?.author_name).toBe("Earlier reply");
    expect(shown).not.toHaveProperty("parent_id");
    // The archive still holds the parent (#1529: threads may show it later).
    const stored = await admin(
      (tx) =>
        tx`SELECT parent_id FROM comment_archive WHERE public_row_id = ${LEGACY_REPLY}::uuid` as Promise<
          { parent_id: string | null }[]
        >,
    );
    expect(stored[0]?.parent_id).not.toBeNull();
  });
});

describe("the bake's signature (#1169)", () => {
  it("counts the whole thread, and moves on an approval and a removal", async () => {
    const before = await signature();
    expect(before).toStartWith(`${THREAD_LENGTH}:`);
    await approve("Moved");
    const after = await signature();
    expect(after).toStartWith(`${THREAD_LENGTH + 1}:`);
    await dropComment("Moved");
    expect(await signature()).toBe(before);
  });

  it("moves when one comment replaces another under the same count and newest instant", async () => {
    const before = await signature();
    await admin(async (tx) => {
      await tx`UPDATE comment_archive SET status = 'rejected'
               WHERE page_id = ${pageId}::uuid AND author_name = 'Author 1'`;
      await tx`
        INSERT INTO comment_archive
          (public_row_id, page_id, author_name, content, status, submitted_at, archived_at)
        SELECT gen_random_uuid(), ${pageId}::uuid, 'Swapped in', 's', 'approved',
               archived_at, archived_at
        FROM comment_archive WHERE page_id = ${pageId}::uuid AND author_name = 'Author 2'`;
    });
    const after = await signature();
    expect(after.split(":").slice(0, 1)).toEqual(before.split(":").slice(0, 1));
    expect(after).not.toBe(before);
    await admin(async (tx) => {
      await tx`DELETE FROM comment_archive
               WHERE page_id = ${pageId}::uuid AND author_name = 'Swapped in'`;
      await tx`UPDATE comment_archive SET status = 'approved'
               WHERE page_id = ${pageId}::uuid AND author_name = 'Author 1'`;
    });
    expect(await signature()).toBe(before);
  });

  it("the batch agrees with the single read, and names a page without comments", async () => {
    const empty = "00000000-0000-4000-8000-000000000000";
    const sign = commentsPlugin.metaSignatureBatch;
    if (!sign) throw new Error("metaSignatureBatch missing");
    const batch = await sign(adminCtx(), { pageIds: [pageId, empty] });
    expect(batch.get(pageId)).toBe(await signature());
    expect(batch.get(empty)).toBe("0:0");
  });

  it("a failed read stops the build instead of freezing the signature", async () => {
    const ctx = { cms: { call: async () => Promise.reject(new Error("db down")) } };
    const sign = commentsPlugin.metaSignature;
    await expect(
      Promise.resolve(sign?.(ctx as unknown as PluginContextTier1, { pageId })),
    ).rejects.toThrow("db down");
  });
});
