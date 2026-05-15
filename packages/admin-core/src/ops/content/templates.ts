// SPDX-License-Identifier: MPL-2.0

/**
 * Template Layer ops (CMS_REQUIREMENTS §3.4). Templates carry the document
 * skeleton; pages compose into them via `template_blocks` slots.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, templateCreateSchema, templateUpdateSchema } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { checkAndAcquireEntityLock, lockedError } from "../../locks.js";
import { emitSnapshot, loadTemplateState } from "../../snapshots/index.js";
import { buildPatchSet } from "../../sql-helpers.js";
import { readSiteDefaults } from "../site_defaults.js";

const templateRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  html: z.string(),
  css: z.string(),
  /** P6.7.6 — every template binds to one layout. */
  layoutId: z.string(),
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
  layout_id: string;
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
    layoutId: t.layout_id,
    createdAt: iso(t.created_at),
    updatedAt: iso(t.updated_at),
    deletedAt: t.deleted_at === null ? null : iso(t.deleted_at),
    blocks: blockMap.get(t.id) ?? [],
  }));
}

export const listTemplatesOp = defineOperation({
  name: "templates.list",
  // CLAUDE.md §11: AI plans cross-template moves and needs broad read.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ includeDeleted: z.boolean().default(false) }),
  output: z.object({ templates: z.array(templateRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const templates = (await tx.execute(
      input.includeDeleted
        ? sql`
            SELECT id::text AS id, slug, display_name, html, css,
                   layout_id::text AS layout_id,
                   created_at, updated_at, deleted_at
            FROM templates ORDER BY created_at ASC
          `
        : sql`
            SELECT id::text AS id, slug, display_name, html, css,
                   layout_id::text AS layout_id,
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
  // CLAUDE.md §11: AI reads template state when planning page changes.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ templateId: z.string().uuid() }),
  output: z.object({ template: templateRowSchema }),
  handler: async (_ctx, input, tx) => {
    const templates = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name, html, css,
             layout_id::text AS layout_id,
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
  // P18 AI-completeness — widened to default scope per CLAUDE.md §11.
  // Creating a NEW template doesn't affect existing pages (they bind by
  // id, not slug); the user just gets a new page-type to compose against.
  // Owner gating still applies to `templates.update` (HTML/CSS rewrites
  // ARE hard-to-revert and cascade across bound pages — that op stays
  // human-only until a §11.A propose/execute gate ships for templates).
  actorScope: ["human", "ai", "system"],
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
        requestId: ctx.requestId,
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
    // P6.7.6 — every template binds to one layout. Caller may pass an
    // explicit layoutId; otherwise resolve to site_defaults at create
    // time. Fail loudly if neither is available — no silent fallback.
    let layoutId = input.layoutId;
    if (layoutId === undefined) {
      const defaults = await readSiteDefaults(tx);
      if (!defaults) {
        return err({
          kind: "HandlerError",
          operation: "templates.create",
          message:
            "no layoutId provided and site_defaults is empty — seed site_defaults via /security/site-defaults or pass an explicit layoutId",
        });
      }
      layoutId = defaults.defaultLayoutId;
    } else {
      const layoutOk = (await tx.execute(sql`
        SELECT 1 FROM layouts WHERE id = ${layoutId}::uuid AND deleted_at IS NULL LIMIT 1
      `)) as unknown as { exists: number }[];
      if (layoutOk.length === 0) {
        return err({
          kind: "HandlerError",
          operation: "templates.create",
          message: "layout not found or deleted",
        });
      }
    }
    const rows = (await tx.execute(sql`
      INSERT INTO templates (slug, display_name, html, css, layout_id)
      VALUES (${input.slug}, ${input.displayName}, ${input.html}, ${input.css}, ${layoutId}::uuid)
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
    // v0.5.21 — auto-derive template_blocks from <caelo-slot name="X">
    // tags in the HTML. Pre-v0.5.21 templates.create created the
    // template row but no block rows; the AI's follow-up
    // add_module_to_page("content") rejected because the block
    // didn't exist. Block names are deduped + ordered by first
    // appearance in HTML; positions are 0-based ascending.
    const slotNames: string[] = [];
    const seenSlots = new Set<string>();
    const slotPattern = /<caelo-slot\s+name=["']([^"']+)["']/gi;
    for (const match of input.html.matchAll(slotPattern)) {
      const name = match[1];
      if (name && !seenSlots.has(name)) {
        seenSlots.add(name);
        slotNames.push(name);
      }
    }
    for (let i = 0; i < slotNames.length; i++) {
      const blockName = slotNames[i];
      if (!blockName) continue;
      await tx.execute(sql`
        INSERT INTO template_blocks (template_id, name, display_name, position)
        VALUES (${templateId}::uuid, ${blockName}, ${blockName}, ${i})
        ON CONFLICT DO NOTHING
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "templates.create",
      input,
      succeeded: true,
      entityId: templateId,
      resultSummary: `slug=${input.slug} blocks=${slotNames.length}`,
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
  // Human-only writes. AI re-points layouts via the narrow
  // `templates.set_layout` op below — never via this surface.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: templateUpdateSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // v0.5.0 — per-entity lock.
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "template",
      entityId: input.templateId,
      chatBranchId: ctx.chatBranchId,
    });
    if (!lock.permitted && lock.holder) {
      return err(lockedError("templates.update", "template", input.templateId, lock.holder));
    }
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
    if (input.layoutId !== undefined) {
      const layoutOk = (await tx.execute(sql`
        SELECT 1 FROM layouts WHERE id = ${input.layoutId}::uuid AND deleted_at IS NULL LIMIT 1
      `)) as unknown as { exists: number }[];
      if (layoutOk.length === 0) {
        return err({
          kind: "HandlerError",
          operation: "templates.update",
          message: "layout not found or deleted",
        });
      }
    }
    const sets = buildPatchSet({
      display_name: input.displayName,
      html: input.html,
      css: input.css,
      layout_id: input.layoutId !== undefined ? sql`${input.layoutId}::uuid` : undefined,
    });
    // buildPatchSet returns an empty fragment when nothing changed —
    // running an UPDATE with no SETs is invalid SQL. Skip the UPDATE
    // when only `blocks` was provided.
    const hasScalarPatch =
      input.displayName !== undefined ||
      input.html !== undefined ||
      input.css !== undefined ||
      input.layoutId !== undefined;
    if (hasScalarPatch) {
      await tx.execute(sql`
        UPDATE templates SET ${sets} WHERE id = ${input.templateId}::uuid
      `);
    }
    // v0.2.65 — Atomic block-set replace when the payload includes
    // blocks. Same DELETE-then-INSERT shape as `template_blocks.set`;
    // running it inside the same transaction means a partial failure
    // leaves zero changes (the propose/execute pattern guarantees
    // atomicity per CLAUDE.md §11.A).
    if (input.blocks !== undefined) {
      const seen = new Set<string>();
      for (const b of input.blocks) {
        if (seen.has(b.name)) {
          return err({
            kind: "HandlerError",
            operation: "templates.update",
            message: `duplicate block name in blocks payload: ${b.name}`,
          });
        }
        seen.add(b.name);
      }
      await tx.execute(
        sql`DELETE FROM template_blocks WHERE template_id = ${input.templateId}::uuid`,
      );
      for (const b of input.blocks) {
        await tx.execute(sql`
          INSERT INTO template_blocks (template_id, name, display_name, position)
          VALUES (${input.templateId}::uuid, ${b.name}, ${b.displayName}, ${b.position})
        `);
      }
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
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

/**
 * P6.7.6 review pass — narrow AI-allowed surface for re-pointing a
 * template's layout. Distinct from `templates.update` so the AI cannot
 * smuggle html/css/displayName patches through a layout-targeting tool.
 */
export const setTemplateLayoutOp = defineOperation({
  name: "templates.set_layout",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      templateId: z.string().uuid(),
      layoutId: z.string().uuid(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const tplOk = (await tx.execute(sql`
      SELECT 1 FROM templates WHERE id = ${input.templateId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (tplOk.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "templates.set_layout",
        message: "template not found",
      });
    }
    const layoutOk = (await tx.execute(sql`
      SELECT 1 FROM layouts WHERE id = ${input.layoutId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (layoutOk.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "templates.set_layout",
        message: "layout not found or deleted",
      });
    }
    await tx.execute(sql`
      UPDATE templates
      SET layout_id = ${input.layoutId}::uuid, updated_at = now()
      WHERE id = ${input.templateId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "templates.set_layout",
      input,
      succeeded: true,
      entityId: input.templateId,
      resultSummary: `layout=${input.layoutId}`,
    });
    const state = await loadTemplateState(tx, input.templateId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "templates.update",
        description: `templates.set_layout slug=${state.slug}`,
        entities: [{ kind: "template", entityId: input.templateId, state }],
      });
    }
    return ok({});
  },
});

export const deleteTemplateOp = defineOperation({
  name: "templates.delete",
  // Why human-only: Owner-only — large blast radius (every page on the template fails).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ templateId: z.string().uuid() }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // v0.5.0 — per-entity lock.
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "template",
      entityId: input.templateId,
      chatBranchId: ctx.chatBranchId,
    });
    if (!lock.permitted && lock.holder) {
      return err(lockedError("templates.delete", "template", input.templateId, lock.holder));
    }
    const inUse = (await tx.execute(sql`
      SELECT 1 FROM pages WHERE template_id = ${input.templateId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (inUse.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
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
        requestId: ctx.requestId,
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
      requestId: ctx.requestId,
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
