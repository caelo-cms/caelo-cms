// SPDX-License-Identifier: MPL-2.0

/**
 * Module Layer ops (CMS_REQUIREMENTS §3.1, §3.2). Modules are the only place
 * raw HTML lives; pages reference them by id. AI is intentionally out of
 * scope here — `actorScope: ["human", "system"]` until P5 widens it.
 */

import { defineOperation } from "@caelo/query-api";
import { err, moduleCreateSchema, moduleUpdateSchema, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { emitSnapshot, loadModuleState } from "../../snapshots/index.js";
import { buildPatchSet } from "../../sql-helpers.js";

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
  actorScope: ["human", "system"],
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
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: moduleUpdateSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const existing = (await tx.execute(sql`
      SELECT 1 FROM modules WHERE id = ${input.moduleId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (existing.length === 0) {
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
      SELECT deleted_at FROM modules WHERE id = ${input.moduleId}::uuid
    `)) as unknown as { deleted_at: Date | null }[];
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
