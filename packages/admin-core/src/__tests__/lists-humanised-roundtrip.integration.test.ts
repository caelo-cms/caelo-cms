// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — a read-modify-write round trip of a list is lossless.
 *
 * `lists.get` humanises references (a media value reads as
 * `/_caelo/media/<slug>`, a query's `parent` as the page's path), the way
 * every read does since epic #724. Writing that read back must store the
 * references again. Regression: `writeList` validated BEFORE storing links
 * as references, so the humanised media value failed the media check and
 * the humanised `parent` failed the query schema — the list editor (and the
 * AI) could not save a list they had just read.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "lists-humanised-roundtrip",
};
const PFX = `lhr-${Date.now().toString(36)}`;
const MEDIA_SHA_PREFIX = "7e1f0b11";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";
let mediaId = "";

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

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYSTEM, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function wipe(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM lists WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM list_types WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM media_assets WHERE sha256 LIKE ${`${MEDIA_SHA_PREFIX}%`}`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  const tpl = await op<{ templateId: string }>("templates.create", {
    slug: `${PFX}-tpl`,
    displayName: `${PFX} TPL`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  await op("template_blocks.set", {
    templateId: tpl.templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  pageId = (
    await op<{ pageId: string }>("pages.create", {
      slug: `${PFX}-docs`,
      title: "Docs",
      templateId: tpl.templateId,
      status: "published",
    })
  ).pageId;
  const sha = `${MEDIA_SHA_PREFIX}${"d".repeat(56)}`;
  mediaId = (
    await op<{ assetId: string }>("media.upload", {
      sha256: sha,
      originalName: "hero.pdf",
      name: `${PFX} Hero`,
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
    })
  ).assetId;
  await op("list_types.upsert_many", {
    listTypes: [
      {
        slug: `${PFX}-cards`,
        name: "Cards",
        purpose: "Teaser cards with an image and a feed of child pages.",
        role: "content",
        root: { allow: ["card", "feed"] },
        nodes: {
          card: {
            label: "Card",
            fields: [
              { name: "title", label: "Title", type: "text", required: true },
              { name: "image", label: "Image", type: "media" },
            ],
          },
          feed: {
            label: "Feed",
            fields: [],
            source: {
              kind: "query",
              editable: ["parent", "limit"],
              defaults: { order: "title_asc", limit: 3 },
            },
          },
        },
      },
    ],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

type ListRead = {
  list: {
    version: number;
    items: {
      id: string;
      node: string;
      values: Record<string, unknown>;
      query?: Record<string, unknown>;
    }[];
  };
};

describe("#1107 lists — humanised read, written back", () => {
  it("stores the media value and the query parent as references again", async () => {
    await op("lists.upsert_many", {
      lists: [
        {
          slug: `${PFX}-home`,
          name: "Home cards",
          purpose: "Cards on the home page.",
          type: `${PFX}-cards`,
          items: [
            { node: "card", values: { title: "Hero", image: `caelo:media/${mediaId}` } },
            { node: "feed", values: {}, query: { parent: `caelo:page/${pageId}` } },
          ],
        },
      ],
    });
    const read = (await op<ListRead>("lists.get", { slug: `${PFX}-home` })).list;
    // The read is humanised: neither value is a reference any more.
    expect(String(read.items[0]?.values.image)).toStartWith("/_caelo/media/");
    expect(String(read.items[1]?.query?.parent)).toStartWith("/");

    await op("lists.upsert_many", {
      lists: [
        {
          slug: `${PFX}-home`,
          name: "Home cards",
          purpose: "Cards on the home page.",
          type: `${PFX}-cards`,
          items: read.items,
          expectedVersion: read.version,
        },
      ],
    });
    const stored = (await asSystem(
      (tx) => tx`SELECT items FROM lists WHERE slug = ${`${PFX}-home`}`,
    )) as { items: ListRead["list"]["items"] }[];
    const items = stored[0]?.items ?? [];
    expect(items[0]?.values.image).toBe(`caelo:media/${mediaId}`);
    expect(items[1]?.query?.parent).toBe(`caelo:page/${pageId}`);
    // Ids survive the round trip.
    expect(items.map((i) => i.id)).toEqual(read.items.map((i) => i.id));
  });

  it("keeps a field's default for an entry that does not set it", async () => {
    await op("list_types.upsert_many", {
      listTypes: [
        {
          slug: `${PFX}-flags`,
          name: "Flags",
          purpose: "Entries with a defaulted tone.",
          role: "content",
          root: { allow: ["flag"] },
          nodes: {
            flag: {
              label: "Flag",
              fields: [
                { name: "label", label: "Label", type: "text", required: true },
                {
                  name: "tone",
                  label: "Tone",
                  type: "select",
                  options: ["calm", "loud"],
                  default: "calm",
                },
              ],
            },
          },
        },
      ],
    });
    await op("lists.upsert_many", {
      lists: [
        {
          slug: `${PFX}-flags`,
          name: "Flags",
          purpose: "Flags for the test.",
          type: `${PFX}-flags`,
          items: [{ node: "flag", values: { label: "A" } }],
        },
      ],
    });
    const read = (await op<ListRead>("lists.get", { slug: `${PFX}-flags` })).list;
    expect(read.items[0]?.values.tone).toBe("calm");
  });
});
