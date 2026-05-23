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
import { setContentInstanceValuesOp } from "./content-instances.js";

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
    // v0.12.0 — set_page_module_content is now a routing SHIM. It looks
    // up the placement's content_instance_id + sync_mode and forwards to
    // content_instances.set_values for the (much more common) unsynced
    // case. Synced placements bounce with a structured error pointing
    // the AI at fork_placement_content or set_content_instance_values
    // so the operator's "edit this hero" intent doesn't silently
    // propagate. Locks + branch isolation + snapshot bookkeeping all
    // live in content_instances.set_values; the shim is concerned only
    // with the routing decision.
    //
    // v0.12.0 — resolve (page, block, position) → content_instance_id
    // via page_modules.content_instance_id (the new binding column).
    // For unsynced placements, route to content_instances.set_values.
    // For synced placements, refuse + point the AI at
    // set_content_instance_values OR fork_placement_content so the
    // operator's "edit this hero on /home" intent doesn't silently
    // propagate to every other page that binds to the same instance.
    const placementRows = (await tx.execute(sql`
      SELECT pm.content_instance_id::text AS content_instance_id, pm.sync_mode,
             ci.version
      FROM page_modules pm
      JOIN content_instances ci ON ci.id = pm.content_instance_id
      WHERE pm.page_id = ${input.pageId}::uuid
        AND pm.block_name = ${input.blockName}
        AND pm.position = ${input.position}
      LIMIT 1
    `)) as unknown as {
      content_instance_id: string;
      sync_mode: "synced" | "unsynced";
      version: number | string;
    }[];
    const placement = placementRows[0];
    if (!placement) {
      return err({
        kind: "HandlerError",
        operation: "page_module_content.set",
        message: `no placement at (${input.blockName}, ${input.position}) on page ${input.pageId}`,
        nextAction: {
          tool: "inspect_page_render",
          args: { pageId: input.pageId },
          reason:
            "fetch the page's actual blocks + placements; pick a (blockName, position) pair that exists and retry",
        },
      });
    }

    if (placement.sync_mode === "synced") {
      return err({
        kind: "HandlerError",
        operation: "page_module_content.set",
        message:
          `placement at (${input.blockName}, ${input.position}) on page ${input.pageId} is SYNCED to content_instance ${placement.content_instance_id}. ` +
          `Editing via set_page_module_content would propagate to every page bound to the same instance, ` +
          `which is rarely the intent of "set the content on this page". ` +
          `Either (a) call set_content_instance_values({ id: "${placement.content_instance_id}", values: ... }) to commit to the blast radius, or ` +
          `(b) call fork_placement_content first to detach this placement into a private instance, then retry.`,
        nextAction: {
          tool: "fork_placement_content",
          args: {
            pageId: input.pageId,
            blockName: input.blockName,
            position: input.position,
          },
          reason:
            "detach this placement so the edit stays local to this page; rerun set_page_module_content after the fork",
        },
      });
    }

    // Unsynced — write through to content_instances.set_values. The
    // op handles the lock + branch isolation + snapshot.
    const setValuesResult = await setContentInstanceValuesOp.handler(
      ctx,
      {
        id: placement.content_instance_id,
        values: input.contentValues,
      },
      tx,
    );
    if (!setValuesResult.ok) {
      // Forward the error with the shim's operation tag so audit + the
      // AI's error-handling expectations stay consistent.
      const inner = setValuesResult.error as {
        message?: string;
        nextAction?: { tool: string; args?: Record<string, unknown>; reason: string };
      };
      return err({
        kind: "HandlerError" as const,
        operation: "page_module_content.set",
        message: inner.message ?? "set_content_instance_values failed",
        nextAction: inner.nextAction,
      });
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "page_module_content.set",
      input,
      succeeded: true,
      entityId: placement.content_instance_id,
      resultSummary: `routed=content_instances.set_values fields=${Object.keys(input.contentValues).length}`,
    });

    return ok({ pageModuleContentId: placement.content_instance_id });
  },
});
