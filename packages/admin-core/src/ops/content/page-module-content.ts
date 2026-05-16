// SPDX-License-Identifier: MPL-2.0

/**
 * v0.4.0 — Page-placement content ops.
 *
 * Module rows hold the structure (HTML/CSS/JS + field schema). The content
 * that fills field placeholders on each page-placement lives here. Per
 * CLAUDE.md, this is the *only* page-level entity that's per-chat-branched:
 * module edits are global + immediate; content edits are page-bound and
 * branch-isolated per chat until publish.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { checkAndAcquireEntityLock, lockedError } from "../../locks.js";
import { emitSnapshot, loadPageModuleContentState } from "../../snapshots/index.js";

const pageModuleContentRowSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  blockName: z.string(),
  position: z.number().int().nonnegative(),
  contentValues: z.record(z.string(), z.unknown()),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function rowTo(r: {
  id: string;
  page_id: string;
  block_name: string;
  position: number;
  content_values: unknown;
  version: number | string;
  created_at: string | Date;
  updated_at: string | Date;
}): z.infer<typeof pageModuleContentRowSchema> {
  const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));
  const raw =
    typeof r.content_values === "string" ? JSON.parse(r.content_values) : r.content_values;
  return {
    id: r.id,
    pageId: r.page_id,
    blockName: r.block_name,
    position: r.position,
    contentValues: (raw ?? {}) as Record<string, unknown>,
    version: typeof r.version === "string" ? Number.parseInt(r.version, 10) : r.version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/**
 * Look up the current content row for a (page, block, position) placement.
 * Returns null if the placement exists in `page_modules` but no content row
 * has been written yet (i.e. before its first edit).
 */
export const getPageModuleContentOp = defineOperation({
  name: "page_module_content.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      blockName: z.string().min(1),
      position: z.number().int().nonnegative(),
    })
    .strict(),
  output: z.object({ content: pageModuleContentRowSchema.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, page_id::text AS page_id, block_name, position,
             content_values, version, created_at, updated_at
      FROM page_module_content
      WHERE page_id = ${input.pageId}::uuid
        AND block_name = ${input.blockName}
        AND position = ${input.position}
      LIMIT 1
    `)) as unknown as Parameters<typeof rowTo>[0][];
    const r = rows[0];
    return ok({ content: r ? rowTo(r) : null });
  },
});

/**
 * Set / upsert the content values for a placement. Emits a snapshot tagged
 * with the caller's `chat_branch_id` so the preview overlay shows the new
 * content only on the chat that authored it; publish merges the branch
 * snapshot into the live row.
 */
export const setPageModuleContentOp = defineOperation({
  name: "page_module_content.set",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      blockName: z.string().min(1),
      position: z.number().int().nonnegative(),
      /**
       * Object mapping module field name → value. Fully replaces the
       * existing `content_values` (callers patch by reading first via
       * `page_module_content.get` if they need merge semantics).
       */
      contentValues: z.record(z.string(), z.unknown()),
    })
    .strict(),
  output: z.object({ pageModuleContentId: z.string() }),
  handler: async (ctx, input, tx) => {
    // v0.5.3 — per-page lock. Content writes are page-bound; two
    // chats editing the same placement would silently overwrite.
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "page",
      entityId: input.pageId,
      chatBranchId: ctx.chatBranchId,
    });
    if (!lock.permitted && lock.holder) {
      return err(lockedError("page_module_content.set", "page", input.pageId, lock.holder));
    }
    // Confirm the placement exists in page_modules — content without a
    // matching placement would orphan + 404 at render time.
    const placement = (await tx.execute(sql`
      SELECT 1 FROM page_modules
      WHERE page_id = ${input.pageId}::uuid
        AND block_name = ${input.blockName}
        AND position = ${input.position}
      LIMIT 1
    `)) as unknown as { exists: number }[];
    if (placement.length === 0) {
      // v0.6.0 W3 — surface a recovery hint so the AI fetches the
      // page's actual block placements instead of guessing again.
      return err({
        kind: "HandlerError",
        operation: "page_module_content.set",
        message: `no placement at (${input.blockName}, ${input.position}) on this page`,
        nextAction: {
          tool: "inspect_page_render",
          args: { pageId: input.pageId },
          reason:
            "fetch the page's actual blocks + placements; pick a (blockName, position) pair that exists and retry",
        },
      });
    }

    const valuesJson = JSON.stringify(input.contentValues);
    const branchId = ctx.chatBranchId ?? null;

    // v0.4.0 — branch isolation. When a chat branch is active, do NOT
    // touch the live page_module_content row; only record a branch
    // snapshot. The preview-time overlay reads the branch snapshot for
    // the active chat, so other chats + the published site keep seeing
    // the prior live state. chat.publish later promotes the branch
    // snapshot to live in one atomic merge.
    //
    // When there's no branch (human or system write outside any chat),
    // the write lands on live directly + emits a no-branch snapshot for
    // global revert history.
    let id: string;
    if (branchId !== null) {
      // Ensure there's a live row so the snapshot has an id to reference.
      // INSERT...DO NOTHING leaves any prior live values intact.
      const existing = (await tx.execute(sql`
        INSERT INTO page_module_content
          (page_id, block_name, position, content_values, version)
        VALUES (${input.pageId}::uuid, ${input.blockName}, ${input.position}, '{}'::jsonb, 1)
        ON CONFLICT (page_id, block_name, position) DO UPDATE SET updated_at = page_module_content.updated_at
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      id = existing[0]?.id ?? "";
    } else {
      const rows = (await tx.execute(sql`
        INSERT INTO page_module_content
          (page_id, block_name, position, content_values, version, updated_at)
        VALUES (
          ${input.pageId}::uuid,
          ${input.blockName},
          ${input.position},
          ${valuesJson}::jsonb,
          1,
          now()
        )
        ON CONFLICT (page_id, block_name, position) DO UPDATE
          SET content_values = EXCLUDED.content_values,
              version = page_module_content.version + 1,
              updated_at = now()
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      id = rows[0]?.id ?? "";
    }
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "page_module_content.set",
        message: "no id returned",
      });
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "page_module_content.set",
      input,
      succeeded: true,
      entityId: id,
      resultSummary: `fields=${Object.keys(input.contentValues).length}${branchId ? " (branch)" : ""}`,
    });

    // Always snapshot. For branched writes, the snapshot carries the
    // desired contentValues (live row may differ). For non-branch writes,
    // the snapshot mirrors live (just-written).
    const state =
      branchId !== null
        ? {
            schemaVersion: 1 as const,
            pageId: input.pageId,
            blockName: input.blockName,
            position: input.position,
            contentValues: input.contentValues,
            version: 1,
          }
        : await loadPageModuleContentState(tx, id);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "page_module_content.set",
        description: `page_module_content.set page=${input.pageId} block=${input.blockName} pos=${input.position}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: branchId,
        entities: [{ kind: "pageModuleContent", entityId: id, state }],
      });
    }

    return ok({ pageModuleContentId: id });
  },
});
