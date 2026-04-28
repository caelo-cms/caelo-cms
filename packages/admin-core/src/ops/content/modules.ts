// SPDX-License-Identifier: MPL-2.0

/**
 * Module Layer ops (CMS_REQUIREMENTS §3.1, §3.2). Modules are the only place
 * raw HTML lives; pages reference them by id. AI is intentionally out of
 * scope here — `actorScope: ["human", "system"]` until P5 widens it.
 */

import { defineOperation } from "@caelo/query-api";
import { err, extractMediaRefs, moduleCreateSchema, moduleUpdateSchema, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { emitSnapshot, loadModuleState } from "../../snapshots/index.js";
import { buildPatchSet } from "../../sql-helpers.js";

/**
 * Diff media references between two HTML strings and apply usage-count
 * deltas. Called from create / update / delete handlers so the AI's
 * `## Media` system-prompt block surfaces frequently-used assets.
 */
async function applyMediaUsageDelta(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  prevHtml: string,
  nextHtml: string,
): Promise<void> {
  const prev = new Set(extractMediaRefs(prevHtml).map((r) => r.assetId));
  const next = new Set(extractMediaRefs(nextHtml).map((r) => r.assetId));
  const deltas = new Map<string, number>();
  for (const id of next) if (!prev.has(id)) deltas.set(id, (deltas.get(id) ?? 0) + 1);
  for (const id of prev) if (!next.has(id)) deltas.set(id, (deltas.get(id) ?? 0) - 1);
  if (deltas.size === 0) return;
  for (const [assetId, delta] of deltas) {
    await tx.execute(sql`
      UPDATE media_assets
      SET usage_count = GREATEST(0, usage_count + ${delta}),
          last_used_at = CASE WHEN ${delta} > 0 THEN now() ELSE last_used_at END
      WHERE id = ${assetId}::uuid AND deleted_at IS NULL
    `);
  }
}

const moduleRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  html: z.string(),
  css: z.string(),
  js: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

function rowToModule(r: {
  id: string;
  slug: string;
  display_name: string;
  html: string;
  css: string;
  js: string;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
}): z.infer<typeof moduleRowSchema> {
  const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    html: r.html,
    css: r.css,
    js: r.js,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: r.deleted_at === null ? null : iso(r.deleted_at),
  };
}

export const listModulesOp = defineOperation({
  name: "modules.list",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ includeDeleted: z.boolean().default(false) }),
  output: z.object({ modules: z.array(moduleRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(
      input.includeDeleted
        ? sql`
            SELECT id::text AS id, slug, display_name, html, css, js,
                   created_at, updated_at, deleted_at
            FROM modules ORDER BY created_at ASC
          `
        : sql`
            SELECT id::text AS id, slug, display_name, html, css, js,
                   created_at, updated_at, deleted_at
            FROM modules WHERE deleted_at IS NULL ORDER BY created_at ASC
          `,
    )) as unknown as Parameters<typeof rowToModule>[0][];
    return ok({ modules: rows.map(rowToModule) });
  },
});

export const getModuleOp = defineOperation({
  name: "modules.get",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ moduleId: z.string().uuid() }),
  output: z.object({ module: moduleRowSchema }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name, html, css, js,
             created_at, updated_at, deleted_at
      FROM modules WHERE id = ${input.moduleId}::uuid LIMIT 1
    `)) as unknown as Parameters<typeof rowToModule>[0][];
    const row = rows[0];
    if (!row) {
      return err({ kind: "HandlerError", operation: "modules.get", message: "module not found" });
    }
    return ok({ module: rowToModule(row) });
  },
});

export const createModuleOp = defineOperation({
  name: "modules.create",
  // P6.7.3 — AI can create modules via the `add_module_to_page` tool
  // (and templates-fan-out variants in later phases). Same audit +
  // snapshot path as a human create, just with actor_kind=ai.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: moduleCreateSchema,
  output: z.object({ moduleId: z.string() }),
  handler: async (ctx, input, tx) => {
    const dup = (await tx.execute(sql`
      SELECT 1 FROM modules WHERE slug = ${input.slug} AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "modules.create",
        input,
        succeeded: false,
        resultSummary: "slug-already-exists",
      });
      return err({
        kind: "HandlerError",
        operation: "modules.create",
        message: "slug already in use",
      });
    }
    const rows = (await tx.execute(sql`
      INSERT INTO modules (slug, display_name, html, css, js)
      VALUES (${input.slug}, ${input.displayName}, ${input.html}, ${input.css}, ${input.js})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const moduleId = rows[0]?.id;
    if (!moduleId) {
      return err({
        kind: "HandlerError",
        operation: "modules.create",
        message: "no id returned",
      });
    }
    // P7 usage-tracker: a fresh module's HTML may already reference
    // existing media (AI tool, paste-from-template, etc.).
    await applyMediaUsageDelta(tx, "", input.html);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "modules.create",
      input,
      succeeded: true,
      entityId: moduleId,
      resultSummary: `slug=${input.slug}`,
    });
    const state = await loadModuleState(tx, moduleId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "modules.create",
        description: `modules.create slug=${input.slug}`,
        entities: [{ kind: "module", entityId: moduleId, state }],
      });
    }
    return ok({ moduleId });
  },
});

export const updateModuleOp = defineOperation({
  name: "modules.update",
  // P5: AI in scope for the `edit_module` tool — the only mutation the
  // AI can reach in this phase. Page / template / cross-module surfaces
  // stay AI-blocked until their tools land in later phases.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: moduleUpdateSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // Fetch prev html before the update so the usage-tracker can diff.
    const prevRows = (await tx.execute(sql`
      SELECT html FROM modules WHERE id = ${input.moduleId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { html: string }[];
    const prev = prevRows[0];
    if (!prev) {
      return err({
        kind: "HandlerError",
        operation: "modules.update",
        message: "module not found",
      });
    }
    // buildPatchSet ignores undefined keys and always appends updated_at = now().
    const sets = buildPatchSet({
      display_name: input.displayName,
      html: input.html,
      css: input.css,
      js: input.js,
    });
    await tx.execute(sql`
      UPDATE modules SET ${sets} WHERE id = ${input.moduleId}::uuid
    `);
    // P7 usage-tracker: only diff when html changed.
    if (input.html !== undefined) {
      await applyMediaUsageDelta(tx, prev.html, input.html);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "modules.update",
      input,
      succeeded: true,
      entityId: input.moduleId,
      resultSummary: `fields=${[
        input.displayName !== undefined && "displayName",
        input.html !== undefined && "html",
        input.css !== undefined && "css",
        input.js !== undefined && "js",
      ]
        .filter(Boolean)
        .join(",")}`,
    });
    const state = await loadModuleState(tx, input.moduleId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "modules.update",
        description: `modules.update slug=${state.slug}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "module", entityId: input.moduleId, state }],
      });
    }
    return ok({});
  },
});

export const deleteModuleOp = defineOperation({
  name: "modules.delete",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ moduleId: z.string().uuid() }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT deleted_at, html FROM modules WHERE id = ${input.moduleId}::uuid
    `)) as unknown as { deleted_at: Date | null; html: string }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "modules.delete",
        message: "module not found",
      });
    }
    if (target.deleted_at !== null) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "modules.delete",
        input,
        succeeded: true,
        entityId: input.moduleId,
        resultSummary: "already-deleted",
      });
      return ok({});
    }
    await tx.execute(sql`
      UPDATE modules SET deleted_at = now() WHERE id = ${input.moduleId}::uuid
    `);
    // P7 usage-tracker: deletion drops every reference the module held.
    await applyMediaUsageDelta(tx, target.html, "");
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "modules.delete",
      input,
      succeeded: true,
      entityId: input.moduleId,
      resultSummary: "soft-deleted",
    });
    const state = await loadModuleState(tx, input.moduleId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "modules.delete",
        description: `modules.delete slug=${state.slug}`,
        entities: [{ kind: "module", entityId: input.moduleId, state }],
      });
    }
    return ok({});
  },
});
