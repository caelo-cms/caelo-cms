// SPDX-License-Identifier: MPL-2.0

/**
 * Template Layer ops (CMS_REQUIREMENTS §3.4). Templates carry the document
 * skeleton; pages compose into them via `template_blocks` slots.
 */

import { defineOperation } from "@caelo/query-api";
import { err, ok, templateCreateSchema, templateUpdateSchema } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { emitSnapshot, loadTemplateState } from "../../snapshots/index.js";
import { buildPatchSet } from "../../sql-helpers.js";

const templateRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  html: z.string(),
  css: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  blocks: z.array(z.object({ name: z.string(), displayName: z.string(), position: z.number() })),
});

type RawTemplateRow = {
  id: string;
  slug: string;
  display_name: string;
  html: string;
  css: string;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
};

type RawBlockRow = {
  template_id: string;
  name: string;
  display_name: string;
  position: number;
};

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowsToTemplates(
  templates: RawTemplateRow[],
  blocks: RawBlockRow[],
): z.infer<typeof templateRowSchema>[] {
  const blockMap = new Map<string, { name: string; displayName: string; position: number }[]>();
  for (const b of blocks) {
    const arr = blockMap.get(b.template_id) ?? [];
    arr.push({ name: b.name, displayName: b.display_name, position: b.position });
    blockMap.set(b.template_id, arr);
  }
  for (const arr of blockMap.values()) arr.sort((a, b) => a.position - b.position);
  return templates.map((t) => ({
    id: t.id,
    slug: t.slug,
    displayName: t.display_name,
    html: t.html,
    css: t.css,
    createdAt: iso(t.created_at),
    updatedAt: iso(t.updated_at),
    deletedAt: t.deleted_at === null ? null : iso(t.deleted_at),
    blocks: blockMap.get(t.id) ?? [],
  }));
}

export const listTemplatesOp = defineOperation({
  name: "templates.list",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ includeDeleted: z.boolean().default(false) }),
  output: z.object({ templates: z.array(templateRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const templates = (await tx.execute(
      input.includeDeleted
        ? sql`
            SELECT id::text AS id, slug, display_name, html, css,
                   created_at, updated_at, deleted_at
            FROM templates ORDER BY created_at ASC
          `
        : sql`
            SELECT id::text AS id, slug, display_name, html, css,
                   created_at, updated_at, deleted_at
            FROM templates WHERE deleted_at IS NULL ORDER BY created_at ASC
          `,
    )) as unknown as RawTemplateRow[];
    const blocks = (await tx.execute(sql`
      SELECT template_id::text AS template_id, name, display_name, position
      FROM template_blocks
    `)) as unknown as RawBlockRow[];
    return ok({ templates: rowsToTemplates(templates, blocks) });
  },
});

export const getTemplateOp = defineOperation({
  name: "templates.get",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ templateId: z.string().uuid() }),
  output: z.object({ template: templateRowSchema }),
  handler: async (_ctx, input, tx) => {
    const templates = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name, html, css,
             created_at, updated_at, deleted_at
      FROM templates WHERE id = ${input.templateId}::uuid LIMIT 1
    `)) as unknown as RawTemplateRow[];
    if (templates.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "templates.get",
        message: "template not found",
      });
    }
    const blocks = (await tx.execute(sql`
      SELECT template_id::text AS template_id, name, display_name, position
      FROM template_blocks WHERE template_id = ${input.templateId}::uuid
    `)) as unknown as RawBlockRow[];
    const composed = rowsToTemplates(templates, blocks);
    const template = composed[0];
    if (!template) {
      return err({
        kind: "HandlerError",
        operation: "templates.get",
        message: "template not found",
      });
    }
    return ok({ template });
  },
});

export const createTemplateOp = defineOperation({
  name: "templates.create",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: templateCreateSchema,
  output: z.object({ templateId: z.string() }),
  handler: async (ctx, input, tx) => {
    const dup = (await tx.execute(sql`
      SELECT 1 FROM templates WHERE slug = ${input.slug} AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "templates.create",
        input,
        succeeded: false,
        resultSummary: "slug-already-exists",
      });
      return err({
        kind: "HandlerError",
        operation: "templates.create",
        message: "slug already in use",
      });
    }
    const rows = (await tx.execute(sql`
      INSERT INTO templates (slug, display_name, html, css)
      VALUES (${input.slug}, ${input.displayName}, ${input.html}, ${input.css})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const templateId = rows[0]?.id;
    if (!templateId) {
      return err({
        kind: "HandlerError",
        operation: "templates.create",
        message: "no id returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "templates.create",
      input,
      succeeded: true,
      entityId: templateId,
      resultSummary: `slug=${input.slug}`,
    });
    const state = await loadTemplateState(tx, templateId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "templates.create",
        description: `templates.create slug=${input.slug}`,
        entities: [{ kind: "template", entityId: templateId, state }],
      });
    }
    return ok({ templateId });
  },
});

export const updateTemplateOp = defineOperation({
  name: "templates.update",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: templateUpdateSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const existing = (await tx.execute(sql`
      SELECT 1 FROM templates WHERE id = ${input.templateId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (existing.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "templates.update",
        message: "template not found",
      });
    }
    const sets = buildPatchSet({
      display_name: input.displayName,
      html: input.html,
      css: input.css,
    });
    await tx.execute(sql`
      UPDATE templates SET ${sets} WHERE id = ${input.templateId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "templates.update",
      input,
      succeeded: true,
      entityId: input.templateId,
    });
    const state = await loadTemplateState(tx, input.templateId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "templates.update",
        description: `templates.update slug=${state.slug}`,
        entities: [{ kind: "template", entityId: input.templateId, state }],
      });
    }
    return ok({});
  },
});

export const deleteTemplateOp = defineOperation({
  name: "templates.delete",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ templateId: z.string().uuid() }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const inUse = (await tx.execute(sql`
      SELECT 1 FROM pages WHERE template_id = ${input.templateId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (inUse.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "templates.delete",
        input,
        succeeded: false,
        entityId: input.templateId,
        resultSummary: "template-in-use",
      });
      return err({
        kind: "HandlerError",
        operation: "templates.delete",
        message: "template is referenced by one or more active pages",
      });
    }
    const rows = (await tx.execute(sql`
      SELECT deleted_at FROM templates WHERE id = ${input.templateId}::uuid
    `)) as unknown as { deleted_at: Date | null }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "templates.delete",
        message: "template not found",
      });
    }
    if (target.deleted_at !== null) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "templates.delete",
        input,
        succeeded: true,
        entityId: input.templateId,
        resultSummary: "already-deleted",
      });
      return ok({});
    }
    await tx.execute(sql`
      UPDATE templates SET deleted_at = now() WHERE id = ${input.templateId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "templates.delete",
      input,
      succeeded: true,
      entityId: input.templateId,
      resultSummary: "soft-deleted",
    });
    const state = await loadTemplateState(tx, input.templateId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "templates.delete",
        description: `templates.delete slug=${state.slug}`,
        entities: [{ kind: "template", entityId: input.templateId, state }],
      });
    }
    return ok({});
  },
});
