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
      requestId: ctx.requestId,
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
  // P8 AI-first review pass: list takes optional filters so the AI
  // can find redirects without paging through everything. `query`
  // matches against fromPath OR toPath substring; `statusCode`
  // narrows to a single status. Both are bounded.
  input: z
    .object({
      query: z.string().max(500).optional(),
      statusCode: z
        .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308), z.literal(410)])
        .optional(),
      limit: z.number().int().positive().max(1000).default(200),
    })
    .strict(),
  output: z.object({
    redirects: z.array(redirectRow),
    totalCount: z.number().int(),
  }),
  handler: async (_ctx, input, tx) => {
    const queryFilter =
      input.query && input.query.length > 0
        ? sql`AND (from_path ILIKE ${`%${input.query}%`} OR to_path ILIKE ${`%${input.query}%`})`
        : sql``;
    const statusFilter =
      input.statusCode !== undefined ? sql`AND status_code = ${input.statusCode}` : sql``;
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, from_path, to_path, status_code,
             created_by::text AS created_by, created_at
      FROM redirects
      WHERE 1 = 1 ${queryFilter} ${statusFilter}
      ORDER BY created_at DESC
      LIMIT ${input.limit}
    `)) as unknown as {
      id: string;
      from_path: string;
      to_path: string;
      status_code: number;
      created_by: string;
      created_at: string | Date;
    }[];
    const totalRows = (await tx.execute(sql`
      SELECT count(*)::int AS count FROM redirects
      WHERE 1 = 1 ${queryFilter} ${statusFilter}
    `)) as unknown as { count: number }[];
    return ok({
      redirects: rows.map((r) => ({
        id: r.id,
        fromPath: r.from_path,
        toPath: r.to_path,
        statusCode: r.status_code,
        createdBy: r.created_by,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
      totalCount: totalRows[0]?.count ?? 0,
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
  // P8 AI-first review pass: AI can manage the redirect lifecycle.
  // Routine cleanup ("delete redirects from /old-blog/*") is exactly
  // the kind of bulk task we want the AI to handle, not the editor.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ redirectId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`DELETE FROM redirects WHERE id = ${input.redirectId}::uuid`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "redirects.delete",
      input,
      succeeded: true,
      entityId: input.redirectId,
    });
    return ok({});
  },
});

// ---------------------------------------------------------------------
// P8 AI-first review pass — bulk variants. Per CLAUDE.md §11, ops that
// would be called N times in one chat turn ship a bulk variant so the
// AI does it in one tool call. Both bulk handlers run inside a single
// transaction → all-or-nothing semantics.
// ---------------------------------------------------------------------

export const createRedirectsManyOp = defineOperation({
  name: "redirects.create_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      redirects: z
        .array(
          z
            .object({
              fromPath: z.string().min(1).max(500).regex(/^\//, "must start with /"),
              toPath: z.string().min(1).max(500).regex(/^\//, "must start with /"),
              statusCode: z
                .union([
                  z.literal(301),
                  z.literal(302),
                  z.literal(307),
                  z.literal(308),
                  z.literal(410),
                ])
                .default(301),
            })
            .strict(),
        )
        .min(1)
        .max(500),
      /** When true, idempotent — existing fromPath rows are updated. */
      upsert: z.boolean().default(false),
    })
    .strict(),
  output: z.object({
    created: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
  }),
  handler: async (ctx, input, tx) => {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const r of input.redirects) {
      if (r.fromPath === r.toPath) {
        skipped += 1;
        continue;
      }
      const existing = (await tx.execute(sql`
        SELECT id::text AS id FROM redirects WHERE from_path = ${r.fromPath} LIMIT 1
      `)) as unknown as { id: string }[];
      if (existing[0]) {
        if (!input.upsert) {
          skipped += 1;
          continue;
        }
        await tx.execute(sql`
          UPDATE redirects SET to_path = ${r.toPath}, status_code = ${r.statusCode}
          WHERE id = ${existing[0].id}::uuid
        `);
        updated += 1;
      } else {
        await tx.execute(sql`
          INSERT INTO redirects (from_path, to_path, status_code, created_by)
          VALUES (${r.fromPath}, ${r.toPath}, ${r.statusCode}, ${ctx.actorId}::uuid)
        `);
        created += 1;
      }
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "redirects.create_many",
      input: { count: input.redirects.length, upsert: input.upsert },
      succeeded: true,
      resultSummary: `created=${created},updated=${updated},skipped=${skipped}`,
    });
    return ok({ created, updated, skipped });
  },
});

export const deleteRedirectsManyOp = defineOperation({
  name: "redirects.delete_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      // Delete by id list, by fromPath list, or by glob match against
      // fromPath. Exactly one of the three must be provided.
      redirectIds: z.array(z.string().uuid()).max(500).optional(),
      fromPaths: z.array(z.string().min(1).max(500)).max(500).optional(),
      /** Substring match against from_path; ILIKE-style. */
      matches: z.string().min(1).max(500).optional(),
    })
    .strict()
    .refine(
      (v) => Number(!!v.redirectIds) + Number(!!v.fromPaths) + Number(!!v.matches) === 1,
      "exactly one of redirectIds / fromPaths / matches is required",
    ),
  output: z.object({ deleted: z.number().int() }),
  handler: async (ctx, input, tx) => {
    let deleted = 0;
    if (input.redirectIds) {
      for (const id of input.redirectIds) {
        const r = (await tx.execute(sql`
          DELETE FROM redirects WHERE id = ${id}::uuid RETURNING 1
        `)) as unknown as { exists: number }[];
        deleted += r.length;
      }
    } else if (input.fromPaths) {
      for (const p of input.fromPaths) {
        const r = (await tx.execute(sql`
          DELETE FROM redirects WHERE from_path = ${p} RETURNING 1
        `)) as unknown as { exists: number }[];
        deleted += r.length;
      }
    } else if (input.matches) {
      const r = (await tx.execute(sql`
        DELETE FROM redirects WHERE from_path ILIKE ${`%${input.matches}%`} RETURNING 1
      `)) as unknown as { exists: number }[];
      deleted += r.length;
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "redirects.delete_many",
      input,
      succeeded: true,
      resultSummary: `deleted=${deleted}`,
    });
    return ok({ deleted });
  },
});
