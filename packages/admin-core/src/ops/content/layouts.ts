// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 — layouts ops. The layout layer sits above templates: every
 * template binds to one layout via `templates.layout_id`, and
 * `layout_modules` attaches modules to the layout's blocks (header /
 * footer / etc.) so chrome reaches every page using any template
 * bound to that layout.
 *
 * Layout creation is Owner-only — `actorScope: ["human","system"]` —
 * so AI tool calls reject at the validator and surface a permission
 * message back to the user. Per CLAUDE.md §2 no-fallbacks invariant,
 * the renderer never substitutes a missing layout; it errors loudly.
 */

import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { emitSnapshot } from "../../snapshots/index.js";

const layoutBlockShape = z.object({
  name: z.string().min(1).max(80),
  displayName: z.string().min(1).max(200),
  position: z.number().int().min(0).max(1000),
});

const layoutRow = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  html: z.string(),
  css: z.string(),
  blocks: z.array(layoutBlockShape),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters/digits/hyphens, leading non-hyphen");

interface RawLayoutRow {
  id: string;
  slug: string;
  display_name: string;
  html: string;
  css: string;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
}

function iso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

async function loadBlocks(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  layoutId: string,
): Promise<z.infer<typeof layoutBlockShape>[]> {
  const rows = (await tx.execute(sql`
    SELECT name, display_name, position FROM layout_blocks
    WHERE layout_id = ${layoutId}::uuid
    ORDER BY position ASC
  `)) as unknown as { name: string; display_name: string; position: number | string }[];
  return rows.map((r) => ({
    name: r.name,
    displayName: r.display_name,
    position: typeof r.position === "string" ? Number.parseInt(r.position, 10) : r.position,
  }));
}

export const listLayoutsOp = defineOperation({
  name: "layouts.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ includeDeleted: z.boolean().default(false) }).strict(),
  output: z.object({ layouts: z.array(layoutRow) }),
  handler: async (_ctx, input, tx) => {
    const filter = input.includeDeleted ? sql`` : sql`WHERE deleted_at IS NULL`;
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name, html, css,
             created_at, updated_at, deleted_at
      FROM layouts ${filter}
      ORDER BY slug ASC
    `)) as unknown as RawLayoutRow[];
    const layouts = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        slug: r.slug,
        displayName: r.display_name,
        html: r.html,
        css: r.css,
        blocks: await loadBlocks(tx, r.id),
        createdAt: iso(r.created_at) ?? "",
        updatedAt: iso(r.updated_at) ?? "",
        deletedAt: iso(r.deleted_at),
      })),
    );
    return ok({ layouts });
  },
});

export const getLayoutOp = defineOperation({
  name: "layouts.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({ layoutId: z.string().uuid().optional(), slug: slugSchema.optional() })
    .strict()
    .refine((v) => v.layoutId !== undefined || v.slug !== undefined, {
      message: "either layoutId or slug is required",
    }),
  output: z.object({ layout: layoutRow.nullable() }),
  handler: async (_ctx, input, tx) => {
    const where = input.layoutId
      ? sql`id = ${input.layoutId}::uuid`
      : sql`slug = ${input.slug ?? ""}`;
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name, html, css,
             created_at, updated_at, deleted_at
      FROM layouts WHERE ${where} LIMIT 1
    `)) as unknown as RawLayoutRow[];
    const r = rows[0];
    if (!r) return ok({ layout: null });
    return ok({
      layout: {
        id: r.id,
        slug: r.slug,
        displayName: r.display_name,
        html: r.html,
        css: r.css,
        blocks: await loadBlocks(tx, r.id),
        createdAt: iso(r.created_at) ?? "",
        updatedAt: iso(r.updated_at) ?? "",
        deletedAt: iso(r.deleted_at),
      },
    });
  },
});

export const createLayoutOp = defineOperation({
  name: "layouts.create",
  // Owner-only. AI calls reject at the validator and surface a
  // permission message to the user.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      slug: slugSchema,
      displayName: z.string().min(1).max(200),
      html: z.string().min(1).max(50_000),
      css: z.string().max(50_000).default(""),
      blocks: z.array(layoutBlockShape).min(1).max(20),
    })
    .strict()
    .refine((v) => v.html.includes('<caelo-slot name="content">'), {
      message: 'layout html must include <caelo-slot name="content">…</caelo-slot>',
      path: ["html"],
    })
    .refine((v) => v.blocks.some((b) => b.name === "content"), {
      message: 'blocks must include a `content` entry',
      path: ["blocks"],
    }),
  output: z.object({ layoutId: z.string() }),
  handler: async (ctx, input, tx) => {
    const dup = (await tx.execute(sql`
      SELECT 1 FROM layouts WHERE slug = ${input.slug} AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "layouts.create",
        message: `layout slug "${input.slug}" already in use`,
      });
    }
    const rows = (await tx.execute(sql`
      INSERT INTO layouts (slug, display_name, html, css)
      VALUES (${input.slug}, ${input.displayName}, ${input.html}, ${input.css})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const layoutId = rows[0]?.id;
    if (!layoutId) {
      return err({ kind: "HandlerError", operation: "layouts.create", message: "no id returned" });
    }
    for (const b of input.blocks) {
      await tx.execute(sql`
        INSERT INTO layout_blocks (layout_id, name, display_name, position)
        VALUES (${layoutId}::uuid, ${b.name}, ${b.displayName}, ${b.position})
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "layouts.create",
      input,
      succeeded: true,
      entityId: layoutId,
      resultSummary: `slug=${input.slug}`,
    });
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "layout_modules.set",
      description: `layouts.create slug=${input.slug}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: ctx.chatBranchId ?? null,
      entities: [],
    });
    return ok({ layoutId });
  },
});

export const updateLayoutOp = defineOperation({
  name: "layouts.update",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      layoutId: z.string().uuid(),
      displayName: z.string().min(1).max(200).optional(),
      html: z.string().min(1).max(50_000).optional(),
      css: z.string().max(50_000).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const sets: ReturnType<typeof sql>[] = [];
    if (input.displayName !== undefined) sets.push(sql`display_name = ${input.displayName}`);
    if (input.html !== undefined) {
      if (!input.html.includes('<caelo-slot name="content">')) {
        return err({
          kind: "HandlerError",
          operation: "layouts.update",
          message: 'layout html must include <caelo-slot name="content">…</caelo-slot>',
        });
      }
      sets.push(sql`html = ${input.html}`);
    }
    if (input.css !== undefined) sets.push(sql`css = ${input.css}`);
    if (sets.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "layouts.update",
        message: "no fields to update",
      });
    }
    sets.push(sql`updated_at = now()`);
    await tx.execute(sql`
      UPDATE layouts SET ${sql.join(sets, sql`, `)}
      WHERE id = ${input.layoutId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "layouts.update",
      input,
      succeeded: true,
      entityId: input.layoutId,
    });
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "layout_modules.set",
      description: `layouts.update id=${input.layoutId}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: ctx.chatBranchId ?? null,
      entities: [],
    });
    return ok({});
  },
});

export const deleteLayoutOp = defineOperation({
  name: "layouts.delete",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ layoutId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // Per the no-fallbacks invariant: refuse to delete a layout that's
    // still referenced by any non-deleted template. The Owner must
    // re-point those templates explicitly via set_template_layout
    // first.
    const refs = (await tx.execute(sql`
      SELECT slug FROM templates
      WHERE layout_id = ${input.layoutId}::uuid AND deleted_at IS NULL LIMIT 5
    `)) as unknown as { slug: string }[];
    if (refs.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "layouts.delete",
        message: `layout still in use by ${refs.length}+ templates: ${refs.map((r) => r.slug).join(", ")}. Re-point those templates first via set_template_layout.`,
      });
    }
    await tx.execute(sql`UPDATE layouts SET deleted_at = now() WHERE id = ${input.layoutId}::uuid`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "layouts.delete",
      input,
      succeeded: true,
      entityId: input.layoutId,
    });
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "layout_modules.set",
      description: `layouts.delete id=${input.layoutId}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: ctx.chatBranchId ?? null,
      entities: [],
    });
    return ok({});
  },
});

export const getLayoutBlockModulesOp = defineOperation({
  name: "layout_modules.get",
  // Read-only — AI uses this to splice when adding to a layout block.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      layoutId: z.string().uuid(),
      blockName: z.string().min(1).max(80),
    })
    .strict(),
  output: z.object({ moduleIds: z.array(z.string()) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT module_id::text AS module_id
      FROM layout_modules
      WHERE layout_id = ${input.layoutId}::uuid AND block_name = ${input.blockName}
      ORDER BY position ASC
    `)) as unknown as { module_id: string }[];
    return ok({ moduleIds: rows.map((r) => r.module_id) });
  },
});

export const setLayoutModulesOp = defineOperation({
  name: "layout_modules.set",
  // Filling the chrome blocks is a content op — AI may call this so it
  // can add a footer / nav-menu module to the site-wide layout.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      layoutId: z.string().uuid(),
      blockName: z.string().min(1).max(80),
      moduleIds: z.array(z.string().uuid()),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // Block must exist on the layout. Layout must not be soft-deleted.
    const layoutRows = (await tx.execute(sql`
      SELECT id FROM layouts WHERE id = ${input.layoutId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { id: string }[];
    if (layoutRows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "layout_modules.set",
        message: "layout not found",
      });
    }
    const blockRows = (await tx.execute(sql`
      SELECT name FROM layout_blocks
      WHERE layout_id = ${input.layoutId}::uuid AND name = ${input.blockName}
      LIMIT 1
    `)) as unknown as { name: string }[];
    if (blockRows.length === 0) {
      const allowed = (await tx.execute(sql`
        SELECT name FROM layout_blocks WHERE layout_id = ${input.layoutId}::uuid
      `)) as unknown as { name: string }[];
      return err({
        kind: "HandlerError",
        operation: "layout_modules.set",
        message: `block "${input.blockName}" not on layout. Available blocks: ${allowed.map((r) => r.name).join(", ")}`,
      });
    }
    if (input.moduleIds.length > 0) {
      const live = (await tx.execute(sql`
        SELECT id::text AS id FROM modules
        WHERE id IN (${sql.join(
          input.moduleIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) AND deleted_at IS NULL
      `)) as unknown as { id: string }[];
      const liveSet = new Set(live.map((r) => r.id));
      const missing = input.moduleIds.filter((id) => !liveSet.has(id));
      if (missing.length > 0) {
        return err({
          kind: "HandlerError",
          operation: "layout_modules.set",
          message: `unknown or deleted module ids: ${missing.join(", ")}`,
        });
      }
    }
    await tx.execute(sql`
      DELETE FROM layout_modules
      WHERE layout_id = ${input.layoutId}::uuid AND block_name = ${input.blockName}
    `);
    let position = 0;
    for (const moduleId of input.moduleIds) {
      await tx.execute(sql`
        INSERT INTO layout_modules (layout_id, block_name, position, module_id)
        VALUES (${input.layoutId}::uuid, ${input.blockName}, ${position}, ${moduleId}::uuid)
      `);
      position += 1;
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "layout_modules.set",
      input,
      succeeded: true,
      entityId: input.layoutId,
      resultSummary: `${input.blockName} modules=${input.moduleIds.length}`,
    });
    // Layout module changes affect chrome on every page using the
    // layout. Snapshot once at the layout level so revert can undo.
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "layout_modules.set",
      description: `layout_modules.set block=${input.blockName}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: ctx.chatBranchId ?? null,
      entities: [],
    });
    return ok({});
  },
});
