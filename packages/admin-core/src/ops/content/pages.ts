// SPDX-License-Identifier: MPL-2.0

/**
 * Page Layer ops (CMS_REQUIREMENTS §3.1, §3.4). Pages reference modules
 * through `page_modules` only — the page schema has no `html` column and the
 * Validator's `.strict()` Zod rejects any `html` key, enforcing the §3.1
 * "no raw HTML on pages" invariant in code.
 */

import { defineOperation } from "@caelo/query-api";
import { err, ok, pageCreateSchema, pageSetModulesSchema, pageUpdateSchema } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { emitSnapshot, loadPageLayoutState, loadPageState } from "../../snapshots/index.js";
import { buildPatchSet, buildWhere } from "../../sql-helpers.js";

const pageRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  locale: z.string(),
  title: z.string(),
  templateId: z.string(),
  status: z.enum(["draft", "published"]),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

const pageWithModulesSchema = pageRowSchema.extend({
  blocks: z.array(
    z.object({
      blockName: z.string(),
      modules: z.array(
        z.object({
          moduleId: z.string(),
          slug: z.string(),
          displayName: z.string(),
          html: z.string(),
          css: z.string(),
          js: z.string(),
          /**
           * True when the referenced module has been soft-deleted since the
           * page was last saved. Composer surfaces a "deleted module" badge;
           * preview / static-gen drop the row. See soft-delete cascade rule
           * (CMS_REQUIREMENTS §3.1, P3 plan §"Risks").
           */
          isDeleted: z.boolean(),
        }),
      ),
    }),
  ),
});

type RawPageRow = {
  id: string;
  slug: string;
  locale: string;
  title: string;
  template_id: string;
  status: "draft" | "published";
  version: number | string;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
};

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowToPage(r: RawPageRow): z.infer<typeof pageRowSchema> {
  // Postgres bigint comes back as a string under bun-sql when the value would
  // overflow JS number — for our version counter (will not approach 2^53)
  // both shapes are safe to coerce.
  const version = typeof r.version === "string" ? Number.parseInt(r.version, 10) : r.version;
  return {
    id: r.id,
    slug: r.slug,
    locale: r.locale,
    title: r.title,
    templateId: r.template_id,
    status: r.status,
    version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: r.deleted_at === null ? null : iso(r.deleted_at),
  };
}

export const listPagesOp = defineOperation({
  name: "pages.list",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({
    includeDeleted: z.boolean().default(false),
    locale: z.string().optional(),
  }),
  output: z.object({ pages: z.array(pageRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const filters = [];
    if (!input.includeDeleted) filters.push(sql`deleted_at IS NULL`);
    if (input.locale !== undefined) filters.push(sql`locale = ${input.locale}`);
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, locale, title, template_id::text AS template_id,
             status, version, created_at, updated_at, deleted_at
      FROM pages
      ${buildWhere(filters)}
      ORDER BY created_at ASC
    `)) as unknown as RawPageRow[];
    return ok({ pages: rows.map(rowToPage) });
  },
});

export const getPageOp = defineOperation({
  name: "pages.get",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ pageId: z.string().uuid() }),
  output: z.object({ page: pageRowSchema }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, locale, title, template_id::text AS template_id,
             status, version, created_at, updated_at, deleted_at
      FROM pages WHERE id = ${input.pageId}::uuid LIMIT 1
    `)) as unknown as RawPageRow[];
    const row = rows[0];
    if (!row) {
      return err({ kind: "HandlerError", operation: "pages.get", message: "page not found" });
    }
    return ok({ page: rowToPage(row) });
  },
});

/**
 * Returns the page row plus its modules grouped by block, in `position` order.
 * Two queries + Map merge — same shape as `users.list` from P2 — is simpler
 * to reason about than a json-aggregating SQL.
 */
export const getPageWithModulesOp = defineOperation({
  name: "pages.get_with_modules",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ pageId: z.string().uuid() }),
  output: z.object({ page: pageWithModulesSchema }),
  handler: async (_ctx, input, tx) => {
    const pageRows = (await tx.execute(sql`
      SELECT id::text AS id, slug, locale, title, template_id::text AS template_id,
             status, version, created_at, updated_at, deleted_at
      FROM pages WHERE id = ${input.pageId}::uuid LIMIT 1
    `)) as unknown as RawPageRow[];
    const pageRow = pageRows[0];
    if (!pageRow) {
      return err({
        kind: "HandlerError",
        operation: "pages.get_with_modules",
        message: "page not found",
      });
    }
    // Composer needs to see deleted-module references too — otherwise an
    // editor opens a page whose modules were soft-deleted out from under
    // them and the layout looks empty for no apparent reason. Each row
    // carries `isDeleted` so the UI can mark the chip and the user can
    // explicitly remove or replace it.
    const modRows = (await tx.execute(sql`
      SELECT pm.block_name AS block_name,
             pm.position AS position,
             m.id::text AS module_id,
             m.slug AS slug,
             m.display_name AS display_name,
             m.html AS html,
             m.css AS css,
             m.js AS js,
             (m.deleted_at IS NOT NULL) AS is_deleted
      FROM page_modules pm
      JOIN modules m ON m.id = pm.module_id
      WHERE pm.page_id = ${input.pageId}::uuid
      ORDER BY pm.block_name ASC, pm.position ASC
    `)) as unknown as {
      block_name: string;
      position: number;
      module_id: string;
      slug: string;
      display_name: string;
      html: string;
      css: string;
      js: string;
      is_deleted: boolean;
    }[];
    const grouped = new Map<
      string,
      {
        moduleId: string;
        slug: string;
        displayName: string;
        html: string;
        css: string;
        js: string;
        isDeleted: boolean;
      }[]
    >();
    for (const r of modRows) {
      const arr = grouped.get(r.block_name) ?? [];
      arr.push({
        moduleId: r.module_id,
        slug: r.slug,
        displayName: r.display_name,
        html: r.html,
        css: r.css,
        js: r.js,
        isDeleted: r.is_deleted,
      });
      grouped.set(r.block_name, arr);
    }
    return ok({
      page: {
        ...rowToPage(pageRow),
        blocks: [...grouped.entries()].map(([blockName, modules]) => ({ blockName, modules })),
      },
    });
  },
});

export const createPageOp = defineOperation({
  name: "pages.create",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: pageCreateSchema,
  output: z.object({ pageId: z.string() }),
  handler: async (ctx, input, tx) => {
    const tplExists = (await tx.execute(sql`
      SELECT 1 FROM templates WHERE id = ${input.templateId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (tplExists.length === 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "pages.create",
        input,
        succeeded: false,
        resultSummary: "template-not-found",
      });
      return err({
        kind: "HandlerError",
        operation: "pages.create",
        message: "template not found or deleted",
      });
    }
    const dup = (await tx.execute(sql`
      SELECT 1 FROM pages
      WHERE slug = ${input.slug} AND locale = ${input.locale} AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "pages.create",
        input,
        succeeded: false,
        resultSummary: "slug-locale-conflict",
      });
      return err({
        kind: "HandlerError",
        operation: "pages.create",
        message: "page already exists for this (slug, locale)",
      });
    }
    const rows = (await tx.execute(sql`
      INSERT INTO pages (slug, locale, title, template_id, status)
      VALUES (${input.slug}, ${input.locale}, ${input.title}, ${input.templateId}::uuid, ${input.status})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const pageId = rows[0]?.id;
    if (!pageId) {
      return err({ kind: "HandlerError", operation: "pages.create", message: "no id returned" });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "pages.create",
      input,
      succeeded: true,
      entityId: pageId,
      resultSummary: `slug=${input.slug},locale=${input.locale}`,
    });
    const state = await loadPageState(tx, pageId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "pages.create",
        description: `pages.create slug=${input.slug} locale=${input.locale}`,
        entities: [{ kind: "page", entityId: pageId, state }],
      });
    }
    return ok({ pageId });
  },
});

export const updatePageOp = defineOperation({
  name: "pages.update",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: pageUpdateSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const existingRows = (await tx.execute(sql`
      SELECT version FROM pages WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { version: number | string }[];
    const existing = existingRows[0];
    if (!existing) {
      return err({
        kind: "HandlerError",
        operation: "pages.update",
        message: "page not found",
      });
    }
    const currentVersion =
      typeof existing.version === "string"
        ? Number.parseInt(existing.version, 10)
        : existing.version;
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "pages.update",
        input,
        succeeded: false,
        entityId: input.pageId,
        resultSummary: `conflict expected=${input.expectedVersion} actual=${currentVersion}`,
      });
      return err({
        kind: "HandlerError",
        operation: "pages.update",
        message: `conflict: page changed since load (expected version ${input.expectedVersion}, current ${currentVersion})`,
      });
    }
    if (input.templateId !== undefined) {
      const tpl = (await tx.execute(sql`
        SELECT 1 FROM templates WHERE id = ${input.templateId}::uuid AND deleted_at IS NULL LIMIT 1
      `)) as unknown as { exists: number }[];
      if (tpl.length === 0) {
        return err({
          kind: "HandlerError",
          operation: "pages.update",
          message: "template not found or deleted",
        });
      }
    }
    // template_id needs an explicit ::uuid cast — pass it as a fragment so the
    // helper just emits `template_id = $n::uuid` rather than `= $n` (which
    // would need a separate query path). version bumps in the same UPDATE so
    // the patch lands atomically with the new token.
    const sets = buildPatchSet({
      title: input.title,
      template_id: input.templateId !== undefined ? sql`${input.templateId}::uuid` : undefined,
      status: input.status,
      version: sql`version + 1`,
    });
    await tx.execute(sql`
      UPDATE pages SET ${sets} WHERE id = ${input.pageId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "pages.update",
      input,
      succeeded: true,
      entityId: input.pageId,
    });
    const state = await loadPageState(tx, input.pageId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "pages.update",
        description: `pages.update slug=${state.slug}`,
        entities: [{ kind: "page", entityId: input.pageId, state }],
      });
    }
    return ok({});
  },
});

/**
 * Atomic replace of a page's modules — DELETE all rows for this page, then
 * INSERT the new layout. Inside one transaction (handler tx) so a partial
 * failure leaves the existing layout intact.
 *
 * Validates that every `blockName` exists on the page's template and that
 * every `moduleId` is non-deleted; both fail with structured `details`.
 */
export const setPageModulesOp = defineOperation({
  name: "pages.set_modules",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: pageSetModulesSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const pageRows = (await tx.execute(sql`
      SELECT template_id::text AS template_id, version FROM pages
      WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { template_id: string; version: number | string }[];
    const pageRow = pageRows[0];
    if (!pageRow) {
      return err({
        kind: "HandlerError",
        operation: "pages.set_modules",
        message: "page not found",
      });
    }
    const currentVersion =
      typeof pageRow.version === "string" ? Number.parseInt(pageRow.version, 10) : pageRow.version;
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "pages.set_modules",
        input,
        succeeded: false,
        entityId: input.pageId,
        resultSummary: `conflict expected=${input.expectedVersion} actual=${currentVersion}`,
      });
      return err({
        kind: "HandlerError",
        operation: "pages.set_modules",
        message: `conflict: page changed since load (expected version ${input.expectedVersion}, current ${currentVersion})`,
      });
    }

    // Verify every blockName exists on the template.
    const allowedRows = (await tx.execute(sql`
      SELECT name FROM template_blocks WHERE template_id = ${pageRow.template_id}::uuid
    `)) as unknown as { name: string }[];
    const allowed = new Set(allowedRows.map((r) => r.name));
    const unknownBlocks = input.blocks.map((b) => b.blockName).filter((n) => !allowed.has(n));
    if (unknownBlocks.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "pages.set_modules",
        input,
        succeeded: false,
        entityId: input.pageId,
        resultSummary: `unknown-blocks=${unknownBlocks.join(",")}`,
      });
      return err({
        kind: "HandlerError",
        operation: "pages.set_modules",
        message: `unknown block names on this template: ${unknownBlocks.join(", ")}`,
      });
    }

    // Verify every moduleId references a non-deleted module.
    const allModuleIds = [...new Set(input.blocks.flatMap((b) => b.moduleIds))];
    if (allModuleIds.length > 0) {
      const liveRows = (await tx.execute(sql`
        SELECT id::text AS id FROM modules
        WHERE id IN (${sql.join(
          allModuleIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) AND deleted_at IS NULL
      `)) as unknown as { id: string }[];
      const liveSet = new Set(liveRows.map((r) => r.id));
      const missing = allModuleIds.filter((id) => !liveSet.has(id));
      if (missing.length > 0) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          operation: "pages.set_modules",
          input,
          succeeded: false,
          entityId: input.pageId,
          resultSummary: `missing-modules=${missing.length}`,
        });
        return err({
          kind: "HandlerError",
          operation: "pages.set_modules",
          message: `unknown or deleted module ids: ${missing.join(", ")}`,
        });
      }
    }

    await tx.execute(sql`DELETE FROM page_modules WHERE page_id = ${input.pageId}::uuid`);
    for (const block of input.blocks) {
      let position = 0;
      for (const moduleId of block.moduleIds) {
        await tx.execute(sql`
          INSERT INTO page_modules (page_id, block_name, position, module_id)
          VALUES (${input.pageId}::uuid, ${block.blockName}, ${position}, ${moduleId}::uuid)
        `);
        position += 1;
      }
    }
    await tx.execute(sql`
      UPDATE pages SET updated_at = now(), version = version + 1
      WHERE id = ${input.pageId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "pages.set_modules",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: `blocks=${input.blocks.length},modules=${allModuleIds.length}`,
    });
    // Layout-only edit — emit a page_layout_snapshot, not a full page snapshot.
    const layoutState = await loadPageLayoutState(tx, input.pageId);
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "pages.set_modules",
      description: `pages.set_modules blocks=${input.blocks.length}`,
      entities: [{ kind: "pageLayout", entityId: input.pageId, state: layoutState }],
    });
    return ok({});
  },
});

export const deletePageOp = defineOperation({
  name: "pages.delete",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ pageId: z.string().uuid() }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT deleted_at FROM pages WHERE id = ${input.pageId}::uuid
    `)) as unknown as { deleted_at: Date | null }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "pages.delete",
        message: "page not found",
      });
    }
    if (target.deleted_at !== null) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "pages.delete",
        input,
        succeeded: true,
        entityId: input.pageId,
        resultSummary: "already-deleted",
      });
      return ok({});
    }
    await tx.execute(sql`UPDATE pages SET deleted_at = now() WHERE id = ${input.pageId}::uuid`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "pages.delete",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: "soft-deleted",
    });
    const state = await loadPageState(tx, input.pageId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "pages.delete",
        description: `pages.delete slug=${state.slug}`,
        entities: [{ kind: "page", entityId: input.pageId, state }],
      });
    }
    return ok({});
  },
});
