// SPDX-License-Identifier: MPL-2.0

/**
 * `plugin_site_media.*` (#530) — a plugin's read access to the site media
 * library, granted per reviewed artifact as `site_media_read`. Each
 * operation runs as the plugin and checks the grant for exactly the
 * running artifact in its own transaction (the private-storage check), so
 * a revocation takes effect on the next call.
 *
 * Images only (PNG, JPEG, WebP, GIF, AVIF): this is for references and
 * inspection, not a general file export. `read` returns where the bytes
 * live; the broker reads them through the host's storage hook — the
 * plugin never sees a storage key.
 */

import {
  defineOperation,
  type OperationDefinition,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { privateGrantRefusal } from "./private-storage.js";

export const SITE_MEDIA_OPS = {
  find: "plugin_site_media.find",
  inspect: "plugin_site_media.inspect",
  read: "plugin_site_media.read",
} as const;

const IMAGE_MIMES = sql`('image/png','image/jpeg','image/webp','image/gif','image/avif')`;

const asset = z.object({
  id: z.string(),
  slug: z.string(),
  mime: z.string(),
  sha256: z.string(),
  sizeBytes: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  alt: z.string(),
  visibility: z.enum(["library", "reference"]),
  derivedFromId: z.string().nullable(),
});
type Asset = z.infer<typeof asset>;

interface AssetRow {
  id: string;
  slug: string;
  mime: string;
  sha256: string;
  size_bytes: string | number;
  width: number | null;
  height: number | null;
  alt: string;
  visibility: "library" | "reference";
  derived_from_id: string | null;
}

const COLUMNS = sql`id::text AS id, slug, mime, sha256, size_bytes, width, height, alt,
  visibility, derived_from_id::text AS derived_from_id`;

const toAsset = (r: AssetRow): Asset => ({
  id: r.id,
  slug: r.slug,
  mime: r.mime,
  sha256: r.sha256,
  sizeBytes: Number(r.size_bytes),
  width: r.width,
  height: r.height,
  alt: r.alt,
  visibility: r.visibility,
  derivedFromId: r.derived_from_id,
});

const denied = (operation: string, message: string) =>
  err({ kind: "HandlerError" as const, operation, message: `PluginSiteMediaDenied: ${message}` });

const findOp = defineOperation({
  name: SITE_MEDIA_OPS.find,
  // Why plugin-only: the grant is the plugin's; humans and the AI use media.list.
  actorScope: ["plugin"],
  database: "cms_admin",
  input: z
    .object({
      query: z.string().max(256).optional(),
      visibility: z.enum(["library", "reference", "all"]).default("library"),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  output: z.object({ assets: z.array(asset) }),
  handler: async (ctx, input, tx) => {
    const refused = await privateGrantRefusal(tx, ctx, "site_media_read");
    if (refused) return denied(SITE_MEDIA_OPS.find, refused);
    const text =
      input.query && input.query.length > 0
        ? sql`AND (alt ILIKE ${`%${input.query}%`} OR original_name ILIKE ${`%${input.query}%`})`
        : sql``;
    const visibility =
      input.visibility === "all" ? sql`` : sql`AND visibility = ${input.visibility}`;
    const rows = (await tx.execute(sql`
      SELECT ${COLUMNS} FROM media_assets
      WHERE deleted_at IS NULL AND mime IN ${IMAGE_MIMES} ${text} ${visibility}
      ORDER BY created_at DESC LIMIT ${input.limit}
    `)) as unknown as AssetRow[];
    return ok({ assets: rows.map(toAsset) });
  },
});

const inspectOp = defineOperation({
  name: SITE_MEDIA_OPS.inspect,
  // Why plugin-only: see find.
  actorScope: ["plugin"],
  database: "cms_admin",
  input: z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(50) }).strict(),
  output: z.object({ assets: z.array(asset) }),
  handler: async (ctx, input, tx) => {
    const refused = await privateGrantRefusal(tx, ctx, "site_media_read");
    if (refused) return denied(SITE_MEDIA_OPS.inspect, refused);
    const out: Asset[] = [];
    for (const ref of input.ids) {
      const byId = z.string().uuid().safeParse(ref).success;
      const rows = (await tx.execute(sql`
        SELECT ${COLUMNS} FROM media_assets
        WHERE ${byId ? sql`id = ${ref}::uuid` : sql`slug = ${ref}`}
          AND deleted_at IS NULL AND mime IN ${IMAGE_MIMES}
      `)) as unknown as AssetRow[];
      if (rows[0]) out.push(toAsset(rows[0]));
    }
    return ok({ assets: out });
  },
});

const readOp = defineOperation({
  name: SITE_MEDIA_OPS.read,
  // Why plugin-only: see find.
  actorScope: ["plugin"],
  database: "cms_admin",
  input: z.object({ id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  output: z.object({ storageKey: z.string(), sizeBytes: z.number(), mime: z.string() }),
  handler: async (ctx, input, tx) => {
    const refused = await privateGrantRefusal(tx, ctx, "site_media_read");
    if (refused) return denied(SITE_MEDIA_OPS.read, refused);
    const rows = (await tx.execute(sql`
      SELECT storage_key, size_bytes, mime FROM media_assets
      WHERE id = ${input.id}::uuid AND sha256 = ${input.sha256}
        AND deleted_at IS NULL AND mime IN ${IMAGE_MIMES}
    `)) as unknown as { storage_key: string; size_bytes: string | number; mime: string }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError" as const,
        operation: SITE_MEDIA_OPS.read,
        message: "SiteMediaNotFound: no live image with this id and sha256 — inspect it again",
      });
    }
    return ok({ storageKey: row.storage_key, sizeBytes: Number(row.size_bytes), mime: row.mime });
  },
});

/** Register the site-media operations (idempotent, like the storage ops). */
export function registerPluginSiteMediaOps(registry: OperationRegistry): void {
  if (registry.has(SITE_MEDIA_OPS.find)) return;
  // The registry stores every op as OperationDefinition<unknown, unknown>.
  for (const op of [findOp, inspectOp, readOp]) {
    registry.register(op as OperationDefinition<unknown, unknown>);
  }
}
