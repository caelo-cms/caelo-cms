// SPDX-License-Identifier: MPL-2.0

/**
 * Page Layer ops (CMS_REQUIREMENTS §3.1, §3.4). Pages reference modules
 * through `page_modules` only — the page schema has no `html` column and the
 * Validator's `.strict()` Zod rejects any `html` key, enforcing the §3.1
 * "no raw HTML on pages" invariant in code.
 */

import { defineOperation } from "@caelo/query-api";
import {
  err,
  extractMediaRefs,
  localeSchema,
  ok,
  pageCreateSchema,
  pageSetModulesSchema,
  pageUpdateSchema,
  slugSchema,
} from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { emitSnapshot, loadPageLayoutState, loadPageState } from "../../snapshots/index.js";
import { buildPatchSet, buildWhere } from "../../sql-helpers.js";
import { readSiteDefaults } from "../site_defaults.js";
import { recomputePageContentHash } from "./content_hash.js";

const pageRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  locale: z.string(),
  /** P6.7.5 — internal editor label, distinct from `title` and `slug`. */
  name: z.string(),
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
  name: string | null;
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
    // P6.7.5 — legacy rows + raw INSERTs may leave `name` null. The
    // rest of the codebase treats name as a non-null friendly label,
    // so we fall back to title here so the editor never shows a blank
    // page picker entry.
    name: r.name ?? r.title,
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
  // P6.7.3 — AI lists pages from add_module_to_template to fan a new
  // module out to every page sharing a template. Read-only.
  actorScope: ["human", "ai", "system"],
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
      SELECT id::text AS id, slug, locale, name, title, template_id::text AS template_id,
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
  // CLAUDE.md §11: AI reads page metadata for planning + tool args.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ pageId: z.string().uuid() }),
  output: z.object({ page: pageRowSchema }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, locale, name, title, template_id::text AS template_id,
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
  // P6.7.3 — AI reads the page's modules to compose Current-page system
  // context and to splice via add_module_to_page. Read-only.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ pageId: z.string().uuid() }),
  output: z.object({ page: pageWithModulesSchema }),
  handler: async (_ctx, input, tx) => {
    const pageRows = (await tx.execute(sql`
      SELECT id::text AS id, slug, locale, name, title, template_id::text AS template_id,
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
  // P6.7.5 — AI calls this via the `create_page` tool. Validator + audit
  // + snapshot all run in the same path as a human create.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: pageCreateSchema,
  output: z.object({ pageId: z.string() }),
  handler: async (ctx, input, tx) => {
    // P6.7.6 — caller may omit templateId; resolve to site_defaults at
    // create time. Failing to resolve = structured error, never a
    // silent fallback (CLAUDE.md §2 no-fallbacks).
    let templateId = input.templateId;
    if (templateId === undefined) {
      const defaults = await readSiteDefaults(tx);
      if (!defaults) {
        return err({
          kind: "HandlerError",
          operation: "pages.create",
          message:
            "no templateId provided and site_defaults is empty — seed site_defaults via /security/site-defaults or pass an explicit templateId",
        });
      }
      templateId = defaults.defaultTemplateId;
    }
    const tplExists = (await tx.execute(sql`
      SELECT 1 FROM templates WHERE id = ${templateId}::uuid AND deleted_at IS NULL LIMIT 1
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
      INSERT INTO pages (slug, locale, name, title, template_id, status)
      VALUES (
        ${input.slug},
        ${input.locale},
        ${input.name ?? input.title},
        ${input.title},
        ${templateId}::uuid,
        ${input.status}
      )
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
    // P9 — initial content_hash (will be empty-blocks until set_modules
    // runs, but populates the column so list/get queries don't NULL-out).
    await recomputePageContentHash(tx, pageId);
    return ok({ pageId });
  },
});

export const updatePageOp = defineOperation({
  name: "pages.update",
  // P6.7.5 — AI calls this via the rename_page / set_page_title /
  // change_page_slug tools. The tool layer carries the intent split
  // (name vs title vs slug) so the AI can never silently substitute
  // one identifier for another.
  actorScope: ["human", "ai", "system"],
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
    // P6.7.5 — `name`, `title`, and `slug` are independently patchable.
    // The slug change additionally needs a (slug, locale) uniqueness
    // pre-check; we run it here since `pages.update` is the canonical
    // mutation entry-point for renames.
    if (input.slug !== undefined) {
      const dup = (await tx.execute(sql`
        SELECT 1 FROM pages
        WHERE slug = ${input.slug}
          AND id <> ${input.pageId}::uuid
          AND deleted_at IS NULL
        LIMIT 1
      `)) as unknown as { exists: number }[];
      if (dup.length > 0) {
        return err({
          kind: "HandlerError",
          operation: "pages.update",
          message: `slug "${input.slug}" already in use`,
        });
      }
    }
    const sets = buildPatchSet({
      name: input.name,
      title: input.title,
      slug: input.slug,
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
  // P6.7.3 — AI writes via add_module_to_page. Branch-aware snapshot
  // emission keeps changes scoped to the chat branch.
  actorScope: ["human", "ai", "system"],
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
    // P9 — content changed; refresh content_hash + recompute
    // translation_status for any variants of this page.
    await recomputePageContentHash(tx, input.pageId);
    return ok({});
  },
});

export const deletePageOp = defineOperation({
  name: "pages.delete",
  // P6.7.5 — AI calls this via the `delete_page` tool. The tool layer
  // requires an explicit `disposition` (404 vs redirect) and a
  // confirmed `redirectTo`; the op stays a plain soft-delete.
  actorScope: ["human", "ai", "system"],
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

/**
 * P6.7.7 — clone an existing page (and its module layout) under a new
 * slug. Modules are referenced by id, not deep-copied: edits to a
 * shared module propagate to every page using it. The duplicated page
 * inherits the source page's templateId by default; callers that need
 * a different page-type pass `targetTemplateId` (validated like
 * pages.update).
 */
export const duplicatePageOp = defineOperation({
  name: "pages.duplicate",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      sourcePageId: z.string().uuid(),
      newSlug: slugSchema,
      newName: z.string().min(1).max(256).optional(),
      newTitle: z.string().min(1).max(256).optional(),
      targetTemplateId: z.string().uuid().optional(),
      locale: localeSchema.optional(),
    })
    .strict(),
  output: z.object({ pageId: z.string() }),
  handler: async (ctx, input, tx) => {
    const sourceRows = (await tx.execute(sql`
      SELECT id::text AS id, slug, locale, name, title,
             template_id::text AS template_id
      FROM pages WHERE id = ${input.sourcePageId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as {
      id: string;
      slug: string;
      locale: string;
      name: string | null;
      title: string;
      template_id: string;
    }[];
    const source = sourceRows[0];
    if (!source) {
      return err({
        kind: "HandlerError",
        operation: "pages.duplicate",
        message: "source page not found",
      });
    }
    const locale = input.locale ?? source.locale;
    const targetTemplateId = input.targetTemplateId ?? source.template_id;
    if (input.targetTemplateId !== undefined) {
      const tplOk = (await tx.execute(sql`
        SELECT 1 FROM templates
        WHERE id = ${input.targetTemplateId}::uuid AND deleted_at IS NULL LIMIT 1
      `)) as unknown as { exists: number }[];
      if (tplOk.length === 0) {
        return err({
          kind: "HandlerError",
          operation: "pages.duplicate",
          message: "target template not found or deleted",
        });
      }
    }
    const dup = (await tx.execute(sql`
      SELECT 1 FROM pages
      WHERE slug = ${input.newSlug} AND locale = ${locale} AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "pages.duplicate",
        message: `page already exists for (slug=${input.newSlug}, locale=${locale})`,
      });
    }
    const title = input.newTitle ?? source.title;
    const name = input.newName ?? title;
    const inserted = (await tx.execute(sql`
      INSERT INTO pages (slug, locale, name, title, template_id, status)
      VALUES (
        ${input.newSlug}, ${locale}, ${name}, ${title},
        ${targetTemplateId}::uuid, 'draft'
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const newPageId = inserted[0]?.id;
    if (!newPageId) {
      return err({
        kind: "HandlerError",
        operation: "pages.duplicate",
        message: "no id returned",
      });
    }
    // Modules carry over by reference — same module ids, same block
    // names, same positions. If the target template has different
    // block names, the migration is the caller's responsibility (use
    // change_template afterward).
    //
    // Filter out source rows whose module is soft-deleted. The plain
    // `INSERT … SELECT FROM page_modules` would otherwise silently
    // propagate dead references into the clone — a regression noticed
    // in the P6.7.7 audit, since `pages.set_modules` rejects deleted
    // module ids at write time and we want the same invariant here.
    // The JOIN drops orphan rows; the audit summary surfaces the count
    // so an operator can investigate the source page's stale links.
    const sourceCounts = (await tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM page_modules WHERE page_id = ${input.sourcePageId}::uuid) AS total,
        (SELECT count(*)::int FROM page_modules pm
           JOIN modules m ON m.id = pm.module_id
           WHERE pm.page_id = ${input.sourcePageId}::uuid AND m.deleted_at IS NULL) AS live
    `)) as unknown as { total: number | string; live: number | string }[];
    const totalSource =
      typeof sourceCounts[0]?.total === "string"
        ? Number.parseInt(sourceCounts[0].total, 10)
        : (sourceCounts[0]?.total ?? 0);
    const liveSource =
      typeof sourceCounts[0]?.live === "string"
        ? Number.parseInt(sourceCounts[0].live, 10)
        : (sourceCounts[0]?.live ?? 0);
    await tx.execute(sql`
      INSERT INTO page_modules (page_id, block_name, position, module_id)
      SELECT ${newPageId}::uuid, pm.block_name, pm.position, pm.module_id
      FROM page_modules pm
      JOIN modules m ON m.id = pm.module_id AND m.deleted_at IS NULL
      WHERE pm.page_id = ${input.sourcePageId}::uuid
    `);
    // P7 review-pass: bump media usage_count for every distinct asset
    // referenced from the cloned modules' HTML. A duplicated page adds
    // a fresh set of live references, so the AI's `## Media` block
    // surfaces the asset as more popular. Same diff helper that
    // modules.update calls; HTML is unchanged so we treat the empty
    // string as "before" and the union of all module HTML as "after".
    const clonedModules = (await tx.execute(sql`
      SELECT m.html FROM page_modules pm
      JOIN modules m ON m.id = pm.module_id AND m.deleted_at IS NULL
      WHERE pm.page_id = ${newPageId}::uuid
    `)) as unknown as { html: string }[];
    if (clonedModules.length > 0) {
      const seen = new Set<string>();
      for (const r of clonedModules) {
        for (const ref of extractMediaRefs(r.html)) seen.add(ref.assetId);
      }
      for (const assetId of seen) {
        await tx.execute(sql`
          UPDATE media_assets
          SET usage_count = usage_count + 1, last_used_at = now()
          WHERE id = ${assetId}::uuid AND deleted_at IS NULL
        `);
      }
    }
    const droppedDeleted = totalSource - liveSource;
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "pages.duplicate",
      input,
      succeeded: true,
      entityId: newPageId,
      resultSummary:
        droppedDeleted > 0
          ? `from=${source.slug} to=${input.newSlug} cloned=${liveSource} dropped_deleted=${droppedDeleted}`
          : `from=${source.slug} to=${input.newSlug} cloned=${liveSource}`,
    });
    const state = await loadPageState(tx, newPageId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "pages.create",
        description: `pages.duplicate from=${source.slug} to=${input.newSlug}`,
        entities: [{ kind: "page", entityId: newPageId, state }],
      });
    }
    const layoutState = await loadPageLayoutState(tx, newPageId);
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "pages.set_modules",
      description: `pages.duplicate layout from=${source.slug}`,
      entities: [{ kind: "pageLayout", entityId: newPageId, state: layoutState }],
    });
    // P9 — populate the clone's content_hash now that its modules are linked.
    await recomputePageContentHash(tx, newPageId);
    return ok({ pageId: newPageId });
  },
});

/**
 * P6.7.7 — re-point a page's templateId, migrating modules where the
 * old + new template have matching block names. Modules in
 * unmatched-named (`orphaned`) blocks are either dropped or relocated
 * to a designated block per `orphanDisposition`. Returns the migrated
 * + dropped lists so the AI can surface them.
 */
export const changeTemplateOp = defineOperation({
  name: "pages.change_template",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      newTemplateId: z.string().uuid(),
      orphanDisposition: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("drop") }).strict(),
        z.object({ kind: z.literal("preserve-as-block"), blockName: slugSchema }).strict(),
      ]),
      expectedVersion: z.number().int().nonnegative().optional(),
    })
    .strict(),
  output: z.object({
    migratedBlocks: z.array(z.string()),
    droppedModules: z.array(z.object({ moduleId: z.string(), formerBlock: z.string() })),
  }),
  handler: async (ctx, input, tx) => {
    const pageRows = (await tx.execute(sql`
      SELECT slug, template_id::text AS template_id, version FROM pages
      WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as {
      slug: string;
      template_id: string;
      version: number | string;
    }[];
    const pageRow = pageRows[0];
    if (!pageRow) {
      return err({
        kind: "HandlerError",
        operation: "pages.change_template",
        message: "page not found",
      });
    }
    const currentVersion =
      typeof pageRow.version === "string" ? Number.parseInt(pageRow.version, 10) : pageRow.version;
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
      return err({
        kind: "HandlerError",
        operation: "pages.change_template",
        message: `conflict: page changed since load (expected ${input.expectedVersion}, current ${currentVersion})`,
      });
    }
    if (pageRow.template_id === input.newTemplateId) {
      return ok({ migratedBlocks: [], droppedModules: [] });
    }
    const tplOk = (await tx.execute(sql`
      SELECT 1 FROM templates
      WHERE id = ${input.newTemplateId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (tplOk.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "pages.change_template",
        message: "new template not found or deleted",
      });
    }
    const newBlockRows = (await tx.execute(sql`
      SELECT name FROM template_blocks WHERE template_id = ${input.newTemplateId}::uuid
    `)) as unknown as { name: string }[];
    const newBlockNames = new Set(newBlockRows.map((r) => r.name));

    if (
      input.orphanDisposition.kind === "preserve-as-block" &&
      !newBlockNames.has(input.orphanDisposition.blockName)
    ) {
      return err({
        kind: "HandlerError",
        operation: "pages.change_template",
        message: `orphan disposition block "${input.orphanDisposition.blockName}" does not exist on the new template`,
      });
    }

    const pmRows = (await tx.execute(sql`
      SELECT block_name, position, module_id::text AS module_id
      FROM page_modules WHERE page_id = ${input.pageId}::uuid
      ORDER BY block_name ASC, position ASC
    `)) as unknown as { block_name: string; position: number; module_id: string }[];

    const migratedBlocks = new Set<string>();
    const droppedModules: { moduleId: string; formerBlock: string }[] = [];
    const survivors: { block_name: string; module_id: string }[] = [];
    const orphanBlock =
      input.orphanDisposition.kind === "preserve-as-block"
        ? input.orphanDisposition.blockName
        : null;
    for (const r of pmRows) {
      if (newBlockNames.has(r.block_name)) {
        migratedBlocks.add(r.block_name);
        survivors.push({ block_name: r.block_name, module_id: r.module_id });
      } else if (orphanBlock !== null) {
        survivors.push({ block_name: orphanBlock, module_id: r.module_id });
      } else {
        droppedModules.push({ moduleId: r.module_id, formerBlock: r.block_name });
      }
    }

    await tx.execute(sql`DELETE FROM page_modules WHERE page_id = ${input.pageId}::uuid`);
    const positionByBlock = new Map<string, number>();
    for (const s of survivors) {
      const pos = positionByBlock.get(s.block_name) ?? 0;
      await tx.execute(sql`
        INSERT INTO page_modules (page_id, block_name, position, module_id)
        VALUES (${input.pageId}::uuid, ${s.block_name}, ${pos}, ${s.module_id}::uuid)
      `);
      positionByBlock.set(s.block_name, pos + 1);
    }
    await tx.execute(sql`
      UPDATE pages
      SET template_id = ${input.newTemplateId}::uuid,
          updated_at = now(),
          version = version + 1
      WHERE id = ${input.pageId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "pages.change_template",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: `migrated=${migratedBlocks.size},dropped=${droppedModules.length}`,
    });
    const state = await loadPageState(tx, input.pageId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "pages.update",
        description: `pages.change_template slug=${pageRow.slug}`,
        entities: [{ kind: "page", entityId: input.pageId, state }],
      });
    }
    const layoutState = await loadPageLayoutState(tx, input.pageId);
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "pages.set_modules",
      description: `pages.change_template layout slug=${pageRow.slug}`,
      entities: [{ kind: "pageLayout", entityId: input.pageId, state: layoutState }],
    });
    return ok({
      migratedBlocks: [...migratedBlocks],
      droppedModules,
    });
  },
});
