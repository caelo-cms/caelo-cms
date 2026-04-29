// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.5 — minimal redirect store. Auto-populated when a page slug
 * changes (`change_page_slug`) or a page is deleted with
 * `disposition='redirect'`. The static generator emits a
 * `_redirects.caddy` snippet and the SvelteKit hooks fall back to the
 * table on a 404 so smoke / dev environments respect the redirect
 * without Caddy in front.
 *
 * Future polish (P8): add a UI to edit / disable / delete; sitemap +
 * canonical-URL surface for SEO; bulk import.
 */

import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";

const redirectRow = z.object({
  id: z.string(),
  fromPath: z.string(),
  toPath: z.string(),
  statusCode: z.number().int(),
  createdBy: z.string(),
  createdAt: z.string(),
});

export const createRedirectOp = defineOperation({
  name: "redirects.create",
  // P6.7.5 — AI tools (change_page_slug, delete_page) write here.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      fromPath: z.string().min(1).max(500).regex(/^\//, "must start with /"),
      // Defense-in-depth: the admin form rewrites already check this,
      // but the AI tool path (and any direct API caller) lands here.
      // 410 Gone redirects use a sentinel `to` that's still rooted.
      toPath: z.string().min(1).max(500).regex(/^\//, "must start with /"),
      statusCode: z
        .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308), z.literal(410)])
        .default(301),
    })
    .strict(),
  output: z.object({ redirectId: z.string() }),
  handler: async (ctx, input, tx) => {
    if (input.fromPath === input.toPath) {
      return err({
        kind: "HandlerError",
        operation: "redirects.create",
        message: "from_path and to_path must differ",
      });
    }
    // Upsert — if a redirect already exists from this path, replace
    // its target. Common during slug ping-pong (rename A→B then B→A).
    const rows = (await tx.execute(sql`
      INSERT INTO redirects (from_path, to_path, status_code, created_by)
      VALUES (${input.fromPath}, ${input.toPath}, ${input.statusCode}, ${ctx.actorId}::uuid)
      ON CONFLICT (from_path) DO UPDATE
        SET to_path = EXCLUDED.to_path,
            status_code = EXCLUDED.status_code,
            created_by = EXCLUDED.created_by,
            created_at = now()
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      return err({ kind: "HandlerError", operation: "redirects.create", message: "no id" });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "redirects.create",
      input,
      succeeded: true,
      entityId: id,
      resultSummary: `${input.fromPath} → ${input.toPath} (${input.statusCode})`,
    });
    return ok({ redirectId: id });
  },
});

export const listRedirectsOp = defineOperation({
  name: "redirects.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ redirects: z.array(redirectRow) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, from_path, to_path, status_code,
             created_by::text AS created_by, created_at
      FROM redirects
      ORDER BY created_at DESC
      LIMIT 1000
    `)) as unknown as {
      id: string;
      from_path: string;
      to_path: string;
      status_code: number;
      created_by: string;
      created_at: string | Date;
    }[];
    return ok({
      redirects: rows.map((r) => ({
        id: r.id,
        fromPath: r.from_path,
        toPath: r.to_path,
        statusCode: r.status_code,
        createdBy: r.created_by,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});

/**
 * Resolve a path to a redirect. Used by the SvelteKit hooks fallback
 * on 404 so the smoke / dev server respects the redirect table without
 * Caddy in front.
 */
export const lookupRedirectOp = defineOperation({
  name: "redirects.lookup",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ fromPath: z.string().min(1).max(500) }).strict(),
  output: z.object({ match: redirectRow.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, from_path, to_path, status_code,
             created_by::text AS created_by, created_at
      FROM redirects WHERE from_path = ${input.fromPath} LIMIT 1
    `)) as unknown as {
      id: string;
      from_path: string;
      to_path: string;
      status_code: number;
      created_by: string;
      created_at: string | Date;
    }[];
    const r = rows[0];
    if (!r) return ok({ match: null });
    return ok({
      match: {
        id: r.id,
        fromPath: r.from_path,
        toPath: r.to_path,
        statusCode: r.status_code,
        createdBy: r.created_by,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      },
    });
  },
});

export const deleteRedirectOp = defineOperation({
  name: "redirects.delete",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ redirectId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`DELETE FROM redirects WHERE id = ${input.redirectId}::uuid`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "redirects.delete",
      input,
      succeeded: true,
      entityId: input.redirectId,
    });
    return ok({});
  },
});
