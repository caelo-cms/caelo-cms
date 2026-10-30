// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1254 — `pages.duplicate` writes no shared media row.
 *
 * `media_assets.usage_count` counts module ROWS whose HTML embeds an asset
 * (media-usage.ts). A duplicate reuses the source's modules, so it adds no
 * row to count. It used to bump every embedded asset anyway — unsorted,
 * row by row — so concurrent duplicates of pages that share media locked
 * the same asset rows in different orders and could deadlock, and the
 * count drifted upward (a deleted copy never decrements; a branch
 * duplicate was never counted at Stage).
 *
 *   - many concurrent duplicates of pages embedding the same assets in
 *     opposite orders all succeed (no deadlock, no lock wait on the asset
 *     rows) and leave every count at the module-row count;
 *   - a duplicate made in a chat leaves the counts unchanged on the
 *     branch and after its Stage.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "pdmu-sys" };
/** Hex, unique per run: the run id as hex digits. */
const SHA_PREFIX = Buffer.from(TS).toString("hex").padEnd(16, "0").slice(0, 16);

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
const assetIds: string[] = [];
const assetSlugs: string[] = [];

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const db = new SQL(ADMIN_URL!);
  try {
    return (await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    })) as T;
  } finally {
    await db.end();
  }
}

async function usageCounts(): Promise<number[]> {
  const rows = (await asSystem(
    (tx) => tx`
      SELECT id::text AS id, usage_count FROM media_assets
       WHERE id = ANY(${`{${assetIds.join(",")}}`}::uuid[])`,
  )) as { id: string; usage_count: number }[];
  const byId = new Map(rows.map((r) => [r.id, Number(r.usage_count)]));
  return assetIds.map((id) => byId.get(id) ?? -1);
}

async function upload(n: number): Promise<{ assetId: string; slug: string }> {
  const sha = `${SHA_PREFIX}${String(n).padStart(48, "0")}`;
  const r = await op<{ assetId: string }>(SYS, "media.upload", {
    sha256: sha,
    originalName: `pdmu-${TS}-${n}.jpg`,
    mime: "image/jpeg",
    sizeBytes: 100,
    width: 10,
    height: 10,
    alt: "",
    storageKey: `${sha}/orig.jpg`,
    variants: [
      {
        variant: "orig",
        format: "jpeg",
        width: 10,
        height: 10,
        sizeBytes: 100,
        storageKey: `${sha}/orig.jpg`,
      },
    ],
  });
  const got = await op<{ asset: { slug: string } }>(SYS, "media.get", { assetId: r.assetId });
  return { assetId: r.assetId, slug: got.asset.slug };
}

async function moduleEmbedding(slug: string, order: readonly number[]): Promise<string> {
  const imgs = order.map((i) => `<img src="/_caelo/media/${assetSlugs[i]}" alt="">`).join("");
  return (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `pdmu-${slug}-${TS}`,
      displayName: `PDMU ${slug}`,
      html: `<section><h2>{{heading}}</h2>${imgs}</section>`,
      // Explicit fields skip the extractor: the media stays in the module
      // HTML, which is what usage_count counts.
      fields: [{ name: "heading", kind: "text", label: "Heading" }],
    })
  ).moduleId;
}

async function pageWith(slug: string, moduleIds: string[]): Promise<string> {
  const pageId = (
    await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `pdmu-${slug}-${TS}`,
      shortTitle: slug,
      title: slug,
      templateId,
    })
  ).pageId;
  await op(SYS, "pages.set_modules", { pageId, blocks: [{ blockName: "content", moduleIds }] });
  return pageId;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      slug: `pdmu-tpl-${TS}`,
      displayName: "PDMU tpl",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content"></caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  for (let n = 0; n < 4; n += 1) {
    const a = await upload(n);
    assetIds.push(a.assetId);
    assetSlugs.push(a.slug);
  }
});

afterAll(async () => {
  await adapter.close();
});

describe("pages.duplicate and media usage (#1254)", () => {
  it("concurrent duplicates of pages sharing media never deadlock and leave the counts at the module-row count", async () => {
    // Two modules embed the same four assets in opposite orders: one row
    // each, so every asset counts 2.
    const forward = await moduleEmbedding("fwd", [0, 1, 2, 3]);
    const backward = await moduleEmbedding("bwd", [3, 2, 1, 0]);
    expect(await usageCounts()).toEqual([2, 2, 2, 2]);
    const pageA = await pageWith("a", [forward, backward]);
    const pageB = await pageWith("b", [backward, forward]);

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        op<{ pageId: string }>(SYS, "pages.duplicate", {
          sourcePageId: i % 2 === 0 ? pageA : pageB,
          newSlug: `pdmu-copy-${i}-${TS}`,
        }),
      ),
    );
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);
    // The duplicates added no module row, so nothing more embeds the assets.
    expect(await usageCounts()).toEqual([2, 2, 2, 2]);
  });

  it("a duplicate in a chat leaves the counts unchanged on the branch and after its Stage", async () => {
    const before = await usageCounts();
    const mod = await moduleEmbedding("chat", [1, 2]);
    const afterModule = await usageCounts();
    expect(afterModule).toEqual([before[0], before[1]! + 1, before[2]! + 1, before[3]]);
    const source = await pageWith("chat-src", [mod]);
    const session = await op<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      { title: `pdmu-chat-${TS}` },
    );
    const chat: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: "pdmu-chat",
      chatBranchId: session.chatBranchId,
      chatTaskId: session.chatSessionId,
    };
    await op(chat, "pages.duplicate", { sourcePageId: source, newSlug: `pdmu-chat-copy-${TS}` });
    expect(await usageCounts()).toEqual(afterModule);
    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [session.chatSessionId] });
    expect(await usageCounts()).toEqual(afterModule);
  });
});
