// SPDX-License-Identifier: MPL-2.0

/**
 * Page Layer ops (CMS_REQUIREMENTS §3.1, §3.4). Pages reference modules
 * through `page_modules` only — the page schema has no `html` column and the
 * Validator's `.strict()` Zod rejects any `html` key, enforcing the §3.1
 * "no raw HTML on pages" invariant in code.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  err,
  extractMediaRefs,
  localeSchema,
  ok,
  pageCreateSchema,
  pageSetModulesSchema,
  pageUpdateSchema,
  slugSchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { branchVisibilityFilter, requireUsableEntity } from "../../branch.js";
import { checkAndAcquireEntityLock, lockedError } from "../../locks.js";
import {
  emitSnapshot,
  loadPageLayoutState,
  loadPageLayoutStateWithBranchOverlay,
  loadPageState,
  loadPageStateWithBranchOverlay,
} from "../../snapshots/index.js";
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
  /**
   * v0.12.0 — page-type kind inherited from the page's template.
   * Surfaced in `## Pages` so the AI sees three modules-on-product-
   * pages as a pattern. Optional on the wire (templates predating
   * migration 0096 don't have it).
   */
  kind: z.enum(["home", "landing", "product", "blog", "doc", "content", "utility"]).optional(),
  status: z.enum(["draft", "published"]),
  /** P9 — populated for source rows; tracks variant freshness. */
  translationStatus: z.enum(["source", "up_to_date", "needs_update", "not_started"]),
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
          /** v0.12.0 — placement → content_instance binding. */
          contentInstanceId: z.string().nullable(),
          syncMode: z.enum(["synced", "unsynced"]),
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
  /** v0.12.0 — joined from `templates.kind`. */
  template_kind?: string | null;
  status: "draft" | "published";
  translation_status: "source" | "up_to_date" | "needs_update" | "not_started";
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
  // v0.12.0 — template_kind comes from the LEFT JOIN; defaults to
  // 'content' for templates that pre-date migration 0096.
  const kindRaw = r.template_kind ?? null;
  const kind: "home" | "landing" | "product" | "blog" | "doc" | "content" | "utility" | undefined =
    kindRaw === "home" ||
    kindRaw === "landing" ||
    kindRaw === "product" ||
    kindRaw === "blog" ||
    kindRaw === "doc" ||
    kindRaw === "content" ||
    kindRaw === "utility"
      ? kindRaw
      : undefined;
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
    ...(kind !== undefined ? { kind } : {}),
    status: r.status,
    translationStatus: r.translation_status,
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
  handler: async (ctx, input, tx) => {
    // v0.9.0 — branch-aware: chats see main + their own branched creates.
    // Filters reference `pages` columns; the LEFT JOIN to templates
    // adds template_kind for the AI's `## Pages` block.
    const filters = [];
    if (!input.includeDeleted) filters.push(sql`pages.deleted_at IS NULL`);
    if (input.locale !== undefined) filters.push(sql`pages.locale = ${input.locale}`);
    if (ctx.chatBranchId) {
      filters.push(
        sql`(pages.chat_branch_id IS NULL OR pages.chat_branch_id = ${ctx.chatBranchId}::uuid)`,
      );
    } else {
      filters.push(sql`pages.chat_branch_id IS NULL`);
    }
    const rows = (await tx.execute(sql`
      SELECT pages.id::text AS id, pages.slug, pages.locale, pages.name, pages.title,
             pages.template_id::text AS template_id,
             templates.kind AS template_kind,
             pages.status, pages.translation_status, pages.version,
             pages.created_at, pages.updated_at, pages.deleted_at
      FROM pages
      LEFT JOIN templates ON templates.id = pages.template_id
      ${buildWhere(filters)}
      ORDER BY pages.created_at ASC
    `)) as unknown as RawPageRow[];
    // Run #9 R9 — caller-branch page-state overlay. A branched
    // `pages.delete` emits a page_snapshots row with `deletedAt` set and
    // leaves the live row untouched until publish (v0.5.3), but this
    // list read only filtered live `deleted_at` — so a page the chat
    // just deleted kept appearing in pages.list, in the `## Pages`
    // context block, and in the /edit sidebar (which lists with the
    // chat's branch ctx). Same regression class as run #8 R3
    // (branch-blind reads): apply the latest branched snapshot per page
    // so deletes (and branched slug/title/status edits) read back.
    if (ctx.chatBranchId && rows.length > 0) {
      const overlayRows = (await tx.execute(sql`
        SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS page_id, ps.state
          FROM page_snapshots ps
          JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
         WHERE ss.chat_branch_id = ${ctx.chatBranchId}::uuid
         ORDER BY ps.page_id, ss.created_at DESC
      `)) as unknown as { page_id: string; state: unknown }[];
      if (overlayRows.length > 0) {
        const overlayById = new Map(overlayRows.map((r) => [r.page_id, r.state]));
        const merged: RawPageRow[] = [];
        for (const row of rows) {
          const rawState = overlayById.get(row.id);
          if (rawState === undefined) {
            merged.push(row);
            continue;
          }
          const s = (typeof rawState === "string" ? JSON.parse(rawState) : rawState) as {
            slug?: string;
            title?: string;
            status?: "draft" | "published";
            version?: number;
            deletedAt?: string | null;
          };
          if (s.deletedAt && !input.includeDeleted) continue;
          merged.push({
            ...row,
            slug: s.slug ?? row.slug,
            title: s.title ?? row.title,
            status: s.status ?? row.status,
            version: s.version ?? row.version,
            deleted_at: s.deletedAt ?? row.deleted_at,
          });
        }
        return ok({ pages: merged.map(rowToPage) });
      }
    }
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
  handler: async (ctx, input, tx) => {
    // v0.9.0 — branch-aware read so chat sees its own branched-create
    // pages immediately after pages.create returns the pageId
    // (re-enables the v0.5.7 workflow that was reverted in v0.5.19).
    const branchFilter = branchVisibilityFilter(ctx);
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, locale, name, title, template_id::text AS template_id,
             status, translation_status, version, created_at, updated_at, deleted_at
      FROM pages WHERE id = ${input.pageId}::uuid ${branchFilter} LIMIT 1
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
  handler: async (ctx, input, tx) => {
    // v0.9.0 — branch-aware so create_page → add_module_to_page chain
    // works inside the same chat without waiting for merge.
    const branchFilter = branchVisibilityFilter(ctx);
    const pageRows = (await tx.execute(sql`
      SELECT id::text AS id, slug, locale, name, title, template_id::text AS template_id,
             status, translation_status, version, created_at, updated_at, deleted_at
      FROM pages WHERE id = ${input.pageId}::uuid ${branchFilter} LIMIT 1
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
    //
    // v0.10.13 — branch-aware layout read. Without the overlay, an AI
    // chain like add_module_to_page → reorder_module on the same chat
    // branch fails ("module X is not on page Y") because
    // `pages.set_modules` in branched mode writes to
    // `page_layout_snapshots` only — the live `page_modules` table
    // stays stale. The overlay returns the latest snapshot's blocks
    // (when present) so chained edits compose; fetches module details
    // separately from `modules` so we still get slug/html/css/js/etc.
    const layoutState = await loadPageLayoutStateWithBranchOverlay(
      tx,
      input.pageId,
      ctx.chatBranchId,
    );
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
        contentInstanceId: string | null;
        syncMode: "synced" | "unsynced";
      }[]
    >();
    const allModuleIds: string[] = [];
    for (const block of layoutState.blocks) {
      for (const id of block.moduleIds) allModuleIds.push(id);
    }
    if (allModuleIds.length > 0) {
      // Fetch module details for the moduleIds referenced by the
      // layout. Branch-aware so modules created on this chat's branch
      // (chat_branch_id = X) are visible alongside main modules.
      const branchFilter2 = branchVisibilityFilter(ctx);
      const modDetailRows = (await tx.execute(sql`
        SELECT id::text AS module_id, slug, display_name, html, css, js,
               (deleted_at IS NOT NULL) AS is_deleted
        FROM modules
        WHERE id = ANY(${sql.raw(`ARRAY[${allModuleIds.map((id) => `'${id}'::uuid`).join(",")}]`)})
          ${branchFilter2}
      `)) as unknown as {
        module_id: string;
        slug: string;
        display_name: string;
        html: string;
        css: string;
        js: string;
        is_deleted: boolean;
      }[];
      const detailById = new Map(modDetailRows.map((r) => [r.module_id, r]));
      // Run #8 R3 — caller-branch module CODE overlay. Branched
      // `modules.update` writes a module_snapshots row only (live
      // `modules` stays untouched until publish), so without this
      // overlay a rebuild's read-back returned the PUBLISHED html/css
      // and the AI re-edited modules it had already rewritten. One
      // batched DISTINCT ON query — same overlay `pages.render_preview`
      // applies for the /edit iframe, so tool reads match what the
      // operator sees.
      if (ctx.chatBranchId && allModuleIds.length > 0) {
        const overlayRows = (await tx.execute(sql`
          SELECT DISTINCT ON (ms.module_id) ms.module_id::text AS module_id, ms.state
          FROM module_snapshots ms
          JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
          WHERE ss.chat_branch_id = ${ctx.chatBranchId}::uuid
            AND ms.module_id = ANY(${sql.raw(
              `ARRAY[${allModuleIds.map((id) => `'${id}'::uuid`).join(",")}]`,
            )})
          ORDER BY ms.module_id, ss.created_at DESC
        `)) as unknown as { module_id: string; state: unknown }[];
        for (const row of overlayRows) {
          const detail = detailById.get(row.module_id);
          if (!detail) continue;
          const s = (typeof row.state === "string" ? JSON.parse(row.state) : row.state) as {
            html?: string;
            css?: string;
            js?: string;
            displayName?: string;
            slug?: string;
            deletedAt?: string | null;
          };
          if (s.deletedAt) continue; // soft-deleted in the overlay — keep live
          detail.html = s.html ?? detail.html;
          detail.css = s.css ?? detail.css;
          detail.js = s.js ?? detail.js;
          detail.display_name = s.displayName ?? detail.display_name;
          detail.slug = s.slug ?? detail.slug;
        }
      }
      // v0.12.0 — placement metadata. Index by (block, position) so
      // the loop below can hand the per-placement sync_mode +
      // content_instance_id to the UI.
      type PlacementMeta = { contentInstanceId: string; syncMode: "synced" | "unsynced" };
      const placementByKey = new Map<string, PlacementMeta>();
      // First check the layout snapshot for per-placement metadata
      // (branched callers get this via layoutState.blocks[i].placements).
      for (const b of layoutState.blocks) {
        const placements = b.placements ?? [];
        for (let i = 0; i < placements.length; i += 1) {
          const p = placements[i];
          if (!p) continue;
          placementByKey.set(`${b.blockName}#${i}`, {
            contentInstanceId: p.contentInstanceId,
            syncMode: p.syncMode,
          });
        }
      }
      // Fall back to live page_modules for any placement the layout
      // snapshot didn't carry (covers pre-v0.12 snapshots + live reads).
      if (placementByKey.size === 0) {
        const liveBindings = (await tx.execute(sql`
          SELECT block_name, position, content_instance_id::text AS content_instance_id, sync_mode
          FROM page_modules
          WHERE page_id = ${input.pageId}::uuid
        `)) as unknown as {
          block_name: string;
          position: number;
          content_instance_id: string;
          sync_mode: "synced" | "unsynced";
        }[];
        for (const r of liveBindings) {
          placementByKey.set(`${r.block_name}#${r.position}`, {
            contentInstanceId: r.content_instance_id,
            syncMode: r.sync_mode,
          });
        }
      }
      for (const block of layoutState.blocks) {
        const arr: {
          moduleId: string;
          slug: string;
          displayName: string;
          html: string;
          css: string;
          js: string;
          isDeleted: boolean;
          contentInstanceId: string | null;
          syncMode: "synced" | "unsynced";
        }[] = [];
        let position = 0;
        for (const id of block.moduleIds) {
          const d = detailById.get(id);
          if (!d) {
            position += 1;
            continue;
          }
          const binding = placementByKey.get(`${block.blockName}#${position}`);
          arr.push({
            moduleId: id,
            slug: d.slug,
            displayName: d.display_name,
            html: d.html,
            css: d.css,
            js: d.js,
            isDeleted: d.is_deleted,
            contentInstanceId: binding?.contentInstanceId ?? null,
            syncMode: binding?.syncMode ?? "unsynced",
          });
          position += 1;
        }
        if (arr.length > 0) grouped.set(block.blockName, arr);
      }
    }
    // v0.2.65 — Surface ALL template blocks, even those the page hasn't
    // assigned modules to yet. Pre-v0.2.65 this op only returned blocks
    // that had at least one module in `page_modules`, so a fresh page on
    // a template with valid blocks reported `blocks: []` and the AI's
    // `add_module_to_page` validator failed with "block 'X' does not
    // exist on this page's template. Available blocks: ".
    //
    // The page's blocks are defined by `template_blocks` for its
    // template_id. Pull those in sorted order, then merge with the
    // module assignments computed above. Empty blocks return as
    // `{blockName, modules: []}`.
    const blockDefRows = (await tx.execute(sql`
      SELECT name, position FROM template_blocks
      WHERE template_id = ${pageRow.template_id}::uuid
      ORDER BY position ASC
    `)) as unknown as { name: string; position: number }[];
    const orderedBlocks = blockDefRows.map((b) => ({
      blockName: b.name,
      modules: grouped.get(b.name) ?? [],
    }));
    // Stragglers: any `page_modules` rows referencing a block name
    // that's no longer on the template (e.g., the template was edited
    // to drop a block but page_modules still has rows). Append them
    // last so the editor can see + clean them up.
    for (const [blockName, modules] of grouped) {
      if (!blockDefRows.some((b) => b.name === blockName)) {
        orderedBlocks.push({ blockName, modules });
      }
    }
    // Run #8 R3 — page meta overlay (slug/title), mirroring the v0.5.5
    // fix in pages.render_preview: branched pages.update writes
    // page_snapshots only, so the live row carries pre-rename values.
    if (ctx.chatBranchId) {
      const pageState = await loadPageStateWithBranchOverlay(tx, input.pageId, ctx.chatBranchId);
      if (pageState) {
        if (pageState.slug) pageRow.slug = pageState.slug;
        if (pageState.title) pageRow.title = pageState.title;
      }
    }
    return ok({
      page: {
        ...rowToPage(pageRow),
        blocks: orderedBlocks,
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
        // v0.6.0 W3 — autoExecute read-only list_templates so the
        // chat-runner can self-correct without bothering the AI for a
        // round-trip. If no templates exist at all, the recovery
        // surfaces an empty list and the second attempt's clean error
        // tells the AI to bootstrap first.
        return err({
          kind: "HandlerError",
          operation: "pages.create",
          message:
            "no templateId provided and site_defaults is empty — seed site_defaults via /security/site-defaults or pass an explicit templateId",
          nextAction: {
            tool: "list_templates",
            reason:
              "fetch the available templates so a UUID can be passed explicitly as templateId on the retry",
            autoExecute: true,
            // v0.6.0 alpha.2 — declarative retry: chat-runner extracts
            // templates[0].id from list_templates.value + re-dispatches
            // pages.create with templateId set. AI never sees the
            // original failure.
            retryWithArgs: { argName: "templateId", fromValuePath: "templates.0.id" },
          },
        });
      }
      templateId = defaults.defaultTemplateId;
    }
    // v0.9.0 — cross-chat write-block: the templateId must be usable
    // by the caller's branch (either main or branched to this chat).
    // Rejects a chat-2 attempt to reference chat-1's branched
    // template (defense-in-depth on top of the branch-aware reads).
    const tplUsable = await requireUsableEntity(tx, ctx, "template", templateId, "pages.create");
    if (!tplUsable.ok) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "pages.create",
        input,
        succeeded: false,
        resultSummary: "template-not-usable",
      });
      return err(tplUsable.error);
    }
    const tplExists = (await tx.execute(sql`
      SELECT 1 FROM templates WHERE id = ${templateId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (tplExists.length === 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "pages.create",
        input,
        succeeded: false,
        resultSummary: "template-not-found",
      });
      return err({
        kind: "HandlerError",
        operation: "pages.create",
        message: "template not found or deleted",
        nextAction: {
          tool: "list_templates",
          reason:
            "fetch valid templateId values; the one you passed does not match a live template",
          autoExecute: true,
        },
      });
    }
    // v0.9.0 — same-branch slug uniqueness only.
    const pageDupNamespace = ctx.chatBranchId ?? "00000000-0000-0000-0000-000000000000";
    const dup = (await tx.execute(sql`
      SELECT 1 FROM pages
      WHERE slug = ${input.slug}
        AND locale = ${input.locale}
        AND deleted_at IS NULL
        AND COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid) = ${pageDupNamespace}::uuid
      LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
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
    // v0.5.19 — pages.create writes LIVE unconditionally (reverts the
    // v0.5.7 branched-create path). Branched pages were invisible to
    // every downstream read tool (pages.get, pages.list,
    // pages.get_with_modules) because those query the live `pages`
    // table — they don't union page_snapshots. AI workflow that
    // creates a page and then attaches modules to it was structurally
    // impossible: create returned a pageId, but every follow-up
    // (add_module_to_page, etc.) failed with "page not found".
    //
    // Hiding new pages from other chats was a real design intent
    // (v0.5.7 §3) but isn't load-bearing — a fresh empty page is
    // harmless to see. Updates + deletes + set_modules stay branched
    // (the load-bearing part of staging), so a chat editing an
    // existing page's slug or layout still keeps that scoped to itself.
    //
    // Snapshot still emitted (with chatBranchId when set) so the page
    // shows up in the chat's branch_change_count + appears in
    // /site-history; publish path's UPSERT no-ops on the create case
    // since the row already exists.
    // v0.9.0 — re-enable branched create. The v0.5.19 reversal of
    // v0.5.7's branched pages.create was because pages.get / pages.list
    // / pages.get_with_modules queried only the live table; branched-
    // only pages were invisible to every "create then operate on" AI
    // workflow. v0.9.0 fixes that by retrofitting branchVisibilityFilter
    // on those reads (lines ~127, ~149, ~177), so the create-then-read
    // chain works again — this time WITH branch isolation as a side
    // effect. Same-chat reads see the new page; cross-chat reads don't;
    // chat.merge_to_main clears the tag to graduate.
    const rows = (await tx.execute(sql`
      INSERT INTO pages (slug, locale, name, title, template_id, status, chat_branch_id)
      VALUES (
        ${input.slug},
        ${input.locale},
        ${input.name ?? input.title},
        ${input.title},
        ${templateId}::uuid,
        ${input.status},
        ${ctx.chatBranchId ?? null}::uuid
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const pageId = rows[0]?.id;
    if (!pageId) {
      return err({ kind: "HandlerError", operation: "pages.create", message: "no id returned" });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
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
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "page", entityId: pageId, state }],
      });
    }
    // P9 — initial content_hash so list/get queries don't NULL-out the
    // column on a freshly-created page. recomputes after set_modules
    // attaches its first module.
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
    // v0.5.3 — per-page lock. Two chats editing the same page (e.g.
    // slug + title) would otherwise step on each other; the lock
    // forces serialisation at write time with a clear actionable
    // error for the second chat.
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "page",
      entityId: input.pageId,
      chatBranchId: ctx.chatBranchId,
    });
    if (!lock.permitted && lock.holder) {
      return err(await lockedError(tx, "pages.update", "page", input.pageId, lock.holder));
    }
    // v0.5.3 — branched update path. When ctx.chatBranchId is set we
    // skip the live UPDATE and emit a branched snapshot carrying the
    // post-patch state, mirroring modules.update's v0.5.1 pattern.
    const branched = !!ctx.chatBranchId;
    const existingRows = (await tx.execute(sql`
      SELECT version, slug, locale, title, template_id::text AS template_id, status, deleted_at
      FROM pages WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as {
      version: number | string;
      slug: string;
      locale: string;
      title: string;
      template_id: string;
      status: "draft" | "published";
      deleted_at: string | Date | null;
    }[];
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
        requestId: ctx.requestId,
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
    if (input.slug !== undefined) {
      // Slug uniqueness still checked against live, even when branched:
      // a chat shouldn't claim a slug another live page already owns.
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

    let state: import("../../snapshots/state.js").PageState | null;
    if (branched) {
      // v0.10.0 — read base state from the LATEST branched snapshot
      // (if one exists for this page+chat), not from the live row.
      // Pre-v0.10.0 chained branched edits silently dropped each
      // other's fields because `existing` came from live — see
      // snapshots/load.ts header comment for the full trace.
      const base = await loadPageStateWithBranchOverlay(tx, input.pageId, ctx.chatBranchId);
      if (!base) {
        return err({
          kind: "HandlerError",
          operation: "pages.update",
          message: "page not found while building branched state",
        });
      }
      state = {
        ...base,
        slug: input.slug ?? base.slug,
        title: input.title ?? base.title,
        templateId: input.templateId ?? base.templateId,
        status: input.status ?? base.status,
        version: currentVersion + 1,
        deletedAt: null,
      };
    } else {
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
      state = await loadPageState(tx, input.pageId);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.update",
      input,
      succeeded: true,
      entityId: input.pageId,
      ...(branched ? { resultSummary: "branched" } : {}),
    });
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "pages.update",
        description: `pages.update slug=${state.slug}${branched ? " (branched)" : ""}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "page", entityId: input.pageId, state }],
      });
    }
    return ok({});
  },
});

/**
 * v0.9.12 — Flip a page's `status` between `draft` and `published`.
 *
 * Different shape from `pages.update`'s branched path on purpose. Status
 * is a per-page deploy-gate flag the user expects to flip immediately
 * AND have stick through Stage, not a branched edit subject to the chat
 * isolation pattern. `pages.update` with a chat branch only emits a
 * snapshot (live row untouched); without a chat branch only updates the
 * live row (snapshot stays stale). Neither alone survives Stage cleanly.
 *
 * This op does both writes in one transaction:
 *   1. UPDATE the live `pages` row so `pages.list` (and the toolbar
 *      badge) reflects the new status immediately.
 *   2. PATCH the LATEST branched `page_snapshots.state.status` for this
 *      page on the active chat's branch (when `ctx.chatBranchId` is
 *      set). Without this patch, `chat.merge_to_main` would UPSERT the
 *      live row from a stale snapshot at Stage and revert the status.
 *
 * Direct UPDATE of `page_snapshots` is intentional here — we're patching
 * an existing snapshot's state, not emitting a new one. The Query API
 * rule "all DB access through ops" still holds: this op IS the op.
 */
export const setPageStatusOp = defineOperation({
  name: "pages.set_status",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({
    pageId: z.string().uuid(),
    status: z.enum(["draft", "published"]),
  }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // pages table has no `updated_by` column (see migration 0005); only
    // `updated_at`. Trying to set updated_by hits "column does not exist".
    const updated = (await tx.execute(sql`
      UPDATE pages
         SET status     = ${input.status},
             version    = version + 1,
             updated_at = now()
       WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL
       RETURNING 1 AS ok
    `)) as unknown as { ok: number }[];
    if (updated.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "pages.set_status",
        message: "page not found",
      });
    }

    if (ctx.chatBranchId) {
      // v0.10.7 — read state, patch in JS, write the whole jsonb back.
      // jsonb_set + to_jsonb on a parameterized text value hits a
      // bun-sql query-prep failure (ERR_POSTGRES_SERVER_ERROR with no
      // SQLSTATE / no PG response — see v0.10.5 / v0.10.6 history).
      // Writing a JSON.stringify'd blob via `::jsonb` cast is the
      // pattern `structured_sets.set` and every audit/proposal write
      // already uses successfully.
      //
      // No-op when the chat has no branched snapshots for this page
      // (SELECT returns 0 rows). That case is correct:
      // `chat.merge_to_main` won't UPSERT a page it has no snapshot
      // for, so the live row's new status stands.
      const latest = (await tx.execute(sql`
        SELECT ps.id::text AS id, ps.state
          FROM page_snapshots ps
          JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
         WHERE ps.page_id = ${input.pageId}::uuid
           AND ss.chat_branch_id = ${ctx.chatBranchId}::uuid
         ORDER BY ss.created_at DESC
         LIMIT 1
      `)) as unknown as { id: string; state: unknown }[];
      const row = latest[0];
      if (row) {
        const stateObj =
          typeof row.state === "string"
            ? (JSON.parse(row.state) as Record<string, unknown>)
            : ((row.state ?? {}) as Record<string, unknown>);
        stateObj.status = input.status;
        const nextJson = JSON.stringify(stateObj);
        await tx.execute(sql`
          UPDATE page_snapshots
             SET state = ${nextJson}::text::jsonb
           WHERE id = ${row.id}::uuid
        `);
      }
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.set_status",
      input,
      succeeded: true,
      entityId: input.pageId,
    });

    return ok({});
  },
});

/**
 * v0.9.13 — Bulk variant of `pages.set_status`. Flips N pages' status in
 * one transaction with the same dual-write contract per page:
 *   1. UPDATE the live `pages` row.
 *   2. PATCH the latest branched `page_snapshots.state.status` for this
 *      page on the active chat's branch (if any).
 *
 * Per CLAUDE.md §11: ships alongside the singular form so the AI can
 * "publish all drafts" in one tool call instead of N. All-or-nothing —
 * the single tx rolls back if any one page fails.
 */
export const setPagesStatusManyOp = defineOperation({
  name: "pages.set_status_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({
    pageIds: z.array(z.string().uuid()).min(1).max(200),
    status: z.enum(["draft", "published"]),
  }),
  output: z.object({ updatedCount: z.number().int().nonnegative() }),
  handler: async (ctx, input, tx) => {
    // Bulk UPDATE in one statement — PostgreSQL handles the N-row write
    // in a single round trip vs N separate UPDATEs from a JS loop.
    // pages table has no `updated_by` column (see singular set_status above).
    const updated = (await tx.execute(sql`
      UPDATE pages
         SET status     = ${input.status},
             version    = version + 1,
             updated_at = now()
       WHERE id = ANY(${sql.raw(`ARRAY[${input.pageIds.map((id) => `'${id}'::uuid`).join(",")}]`)})
         AND deleted_at IS NULL
       RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    if (updated.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "pages.set_status_many",
        message: "no matching pages found",
      });
    }

    // Patch the latest branched snapshot for each updated page on this
    // chat's branch. v0.10.7 — read state, patch in JS, write whole
    // blob back per-snapshot. See singular variant for why jsonb_set
    // can't be used here.
    if (ctx.chatBranchId) {
      const latest = (await tx.execute(sql`
        SELECT DISTINCT ON (ps.page_id) ps.id::text AS id, ps.state
          FROM page_snapshots ps
          JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
         WHERE ps.page_id = ANY(${sql.raw(`ARRAY[${input.pageIds.map((id) => `'${id}'::uuid`).join(",")}]`)})
           AND ss.chat_branch_id = ${ctx.chatBranchId}::uuid
         ORDER BY ps.page_id, ss.created_at DESC
      `)) as unknown as { id: string; state: unknown }[];
      for (const row of latest) {
        const stateObj =
          typeof row.state === "string"
            ? (JSON.parse(row.state) as Record<string, unknown>)
            : ((row.state ?? {}) as Record<string, unknown>);
        stateObj.status = input.status;
        const nextJson = JSON.stringify(stateObj);
        await tx.execute(sql`
          UPDATE page_snapshots
             SET state = ${nextJson}::text::jsonb
           WHERE id = ${row.id}::uuid
        `);
      }
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.set_status_many",
      input,
      succeeded: true,
      resultSummary: `updated=${updated.length}`,
    });

    return ok({ updatedCount: updated.length });
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
    const setModulesLock = await checkAndAcquireEntityLock(tx, {
      kind: "page",
      entityId: input.pageId,
      chatBranchId: ctx.chatBranchId,
    });
    if (!setModulesLock.permitted && setModulesLock.holder) {
      return err(
        await lockedError(tx, "pages.set_modules", "page", input.pageId, setModulesLock.holder),
      );
    }
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
        requestId: ctx.requestId,
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
        requestId: ctx.requestId,
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
      // v0.9.0 — cross-chat write-block: each moduleId must be on
      // main or branched to the caller's chat. References to another
      // chat's branched module get rejected here (defense-in-depth
      // on top of the branch-aware reads above).
      for (const mid of allModuleIds) {
        const check = await requireUsableEntity(tx, ctx, "module", mid, "pages.set_modules");
        if (!check.ok) return err(check.error);
      }
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
          requestId: ctx.requestId,
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

    // v0.12.0 — page_modules requires content_instance_id NOT NULL.
    // Read the current state so we can preserve content bindings for
    // placements that survive (same blockName, position, moduleId) and
    // mint fresh unsynced content_instances for net-new placements.
    const priorRows = (await tx.execute(sql`
      SELECT block_name, position, module_id::text AS module_id,
             content_instance_id::text AS content_instance_id, sync_mode
      FROM page_modules WHERE page_id = ${input.pageId}::uuid
    `)) as unknown as {
      block_name: string;
      position: number;
      module_id: string;
      content_instance_id: string;
      sync_mode: "synced" | "unsynced";
    }[];
    const priorByKey = new Map<
      string,
      { moduleId: string; contentInstanceId: string; syncMode: "synced" | "unsynced" }
    >();
    for (const r of priorRows) {
      priorByKey.set(`${r.block_name}#${r.position}`, {
        moduleId: r.module_id,
        contentInstanceId: r.content_instance_id,
        syncMode: r.sync_mode,
      });
    }

    // Resolve `(moduleId, contentInstanceId, syncMode)` for every new
    // placement. Mint fresh unsynced content_instances where needed —
    // this happens in BOTH branched and live paths so the snapshot's
    // `placements` array carries authoritative bindings.
    type ResolvedPlacement = {
      blockName: string;
      position: number;
      moduleId: string;
      contentInstanceId: string;
      syncMode: "synced" | "unsynced";
    };
    const resolved: ResolvedPlacement[] = [];
    for (const block of input.blocks) {
      let position = 0;
      for (const moduleId of block.moduleIds) {
        const prior = priorByKey.get(`${block.blockName}#${position}`);
        let contentInstanceId: string;
        let syncMode: "synced" | "unsynced";
        if (prior && prior.moduleId === moduleId) {
          // Same module survives at the same slot — preserve binding.
          contentInstanceId = prior.contentInstanceId;
          syncMode = prior.syncMode;
        } else {
          // New placement or module swap — mint fresh unsynced content_instance.
          const minted = (await tx.execute(sql`
            INSERT INTO content_instances
              (module_id, "values", updated_by, chat_branch_id)
            VALUES (
              ${moduleId}::uuid,
              '{}'::jsonb,
              ${ctx.actorId}::uuid,
              ${ctx.chatBranchId ?? null}::uuid
            )
            RETURNING id::text AS id
          `)) as unknown as { id: string }[];
          const newId = minted[0]?.id;
          if (!newId) {
            return err({
              kind: "HandlerError",
              operation: "pages.set_modules",
              message: "failed to mint content_instance for new placement",
            });
          }
          contentInstanceId = newId;
          syncMode = "unsynced";
        }
        resolved.push({
          blockName: block.blockName,
          position,
          moduleId,
          contentInstanceId,
          syncMode,
        });
        position += 1;
      }
    }

    // v0.5.3 — branched: skip live page_modules write; build the
    // layout state in-memory and emit branched snapshot.
    const branched = !!ctx.chatBranchId;
    let layoutState: import("../../snapshots/state.js").PageLayoutState;
    if (branched) {
      const byBlock = new Map<string, ResolvedPlacement[]>();
      for (const p of resolved) {
        const arr = byBlock.get(p.blockName) ?? [];
        arr.push(p);
        byBlock.set(p.blockName, arr);
      }
      layoutState = {
        schemaVersion: 1,
        blocks: input.blocks.map((b) => ({
          blockName: b.blockName,
          moduleIds: [...b.moduleIds],
          placements: (byBlock.get(b.blockName) ?? []).map((p) => ({
            moduleId: p.moduleId,
            contentInstanceId: p.contentInstanceId,
            syncMode: p.syncMode,
          })),
        })),
      };
    } else {
      await tx.execute(sql`DELETE FROM page_modules WHERE page_id = ${input.pageId}::uuid`);
      for (const p of resolved) {
        await tx.execute(sql`
          INSERT INTO page_modules
            (page_id, block_name, position, module_id, content_instance_id, sync_mode)
          VALUES (
            ${input.pageId}::uuid,
            ${p.blockName},
            ${p.position},
            ${p.moduleId}::uuid,
            ${p.contentInstanceId}::uuid,
            ${p.syncMode}
          )
        `);
      }
      await tx.execute(sql`
        UPDATE pages SET updated_at = now(), version = version + 1
        WHERE id = ${input.pageId}::uuid
      `);
      layoutState = await loadPageLayoutState(tx, input.pageId);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.set_modules",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: `blocks=${input.blocks.length},modules=${allModuleIds.length}${branched ? ",branched" : ""}`,
    });
    // Layout-only edit — emit a page_layout_snapshot, not a full page snapshot.
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "pages.set_modules",
      description: `pages.set_modules blocks=${input.blocks.length}${branched ? " (branched)" : ""}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: ctx.chatBranchId ?? null,
      entities: [{ kind: "pageLayout", entityId: input.pageId, state: layoutState }],
    });
    // P9 — content changed; refresh content_hash + recompute
    // translation_status for any variants of this page. Skip when
    // branched — live content is unchanged.
    if (!branched) {
      await recomputePageContentHash(tx, input.pageId);
    }
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
    const deleteLock = await checkAndAcquireEntityLock(tx, {
      kind: "page",
      entityId: input.pageId,
      chatBranchId: ctx.chatBranchId,
    });
    if (!deleteLock.permitted && deleteLock.holder) {
      return err(await lockedError(tx, "pages.delete", "page", input.pageId, deleteLock.holder));
    }
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
        requestId: ctx.requestId,
        operation: "pages.delete",
        input,
        succeeded: true,
        entityId: input.pageId,
        resultSummary: "already-deleted",
      });
      return ok({});
    }
    // v0.5.3 — branched: skip live soft-delete; emit branched snapshot
    // with deletedAt set so preview hides the page in the caller's chat.
    const branched = !!ctx.chatBranchId;
    let state: import("../../snapshots/state.js").PageState | null;
    if (branched) {
      const prev = (await tx.execute(sql`
        SELECT slug, locale, title, template_id::text AS template_id, status, version
        FROM pages WHERE id = ${input.pageId}::uuid LIMIT 1
      `)) as unknown as {
        slug: string;
        locale: string;
        title: string;
        template_id: string;
        status: "draft" | "published";
        version: number | string;
      }[];
      const p = prev[0];
      state = p
        ? {
            schemaVersion: 1,
            slug: p.slug,
            locale: p.locale,
            title: p.title,
            templateId: p.template_id,
            status: p.status,
            version: typeof p.version === "string" ? Number.parseInt(p.version, 10) : p.version,
            deletedAt: new Date().toISOString(),
          }
        : null;
    } else {
      await tx.execute(sql`UPDATE pages SET deleted_at = now() WHERE id = ${input.pageId}::uuid`);
      state = await loadPageState(tx, input.pageId);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.delete",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: branched ? "branched soft-delete" : "soft-deleted",
    });
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "pages.delete",
        description: `pages.delete slug=${state.slug}${branched ? " (branched)" : ""}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
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
    // v0.12.0 — duplicate must clone the source's content_instances too,
    // not just rebind to them. A true "duplicate" lets the operator
    // diverge the clone's content without affecting the source — so for
    // each source placement we mint a fresh unsynced content_instance
    // with the source's values copied, then bind the clone's
    // page_modules row to the new ci. (Shared-synced semantics are
    // available via set_placement_content after duplicate completes.)
    await tx.execute(sql`
      WITH source_placements AS (
        SELECT pm.block_name, pm.position, pm.module_id, pm.content_instance_id, pm.sync_mode
        FROM page_modules pm
        JOIN modules m ON m.id = pm.module_id AND m.deleted_at IS NULL
        WHERE pm.page_id = ${input.sourcePageId}::uuid
      ),
      cloned_cis AS (
        INSERT INTO content_instances (module_id, slug, display_name, "values", updated_by, chat_branch_id)
        SELECT
          sp.module_id,
          NULL,
          NULL,
          COALESCE(ci."values", '{}'::jsonb),
          ${ctx.actorId}::uuid,
          ${ctx.chatBranchId ?? null}::uuid
        FROM source_placements sp
        LEFT JOIN content_instances ci ON ci.id = sp.content_instance_id
        RETURNING id, module_id
      ),
      indexed_sources AS (
        SELECT
          sp.*,
          ROW_NUMBER() OVER (PARTITION BY sp.module_id ORDER BY sp.block_name, sp.position) AS rn
        FROM source_placements sp
      ),
      indexed_clones AS (
        SELECT
          cc.id, cc.module_id,
          ROW_NUMBER() OVER (PARTITION BY cc.module_id ORDER BY cc.id) AS rn
        FROM cloned_cis cc
      )
      INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
      SELECT
        ${newPageId}::uuid,
        s.block_name,
        s.position,
        s.module_id,
        c.id,
        'unsynced'
      FROM indexed_sources s
      JOIN indexed_clones c ON c.module_id = s.module_id AND c.rn = s.rn
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
      requestId: ctx.requestId,
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

    // v0.12.0 — preserve content_instance_id + sync_mode through the
    // re-bind. change_template is a chrome change; the page's content
    // should ride through unchanged.
    const pmRows = (await tx.execute(sql`
      SELECT
        block_name,
        position,
        module_id::text AS module_id,
        content_instance_id::text AS content_instance_id,
        sync_mode
      FROM page_modules WHERE page_id = ${input.pageId}::uuid
      ORDER BY block_name ASC, position ASC
    `)) as unknown as {
      block_name: string;
      position: number;
      module_id: string;
      content_instance_id: string;
      sync_mode: "synced" | "unsynced";
    }[];

    const migratedBlocks = new Set<string>();
    const droppedModules: { moduleId: string; formerBlock: string }[] = [];
    const survivors: {
      block_name: string;
      module_id: string;
      content_instance_id: string;
      sync_mode: "synced" | "unsynced";
    }[] = [];
    const orphanBlock =
      input.orphanDisposition.kind === "preserve-as-block"
        ? input.orphanDisposition.blockName
        : null;
    for (const r of pmRows) {
      if (newBlockNames.has(r.block_name)) {
        migratedBlocks.add(r.block_name);
        survivors.push({
          block_name: r.block_name,
          module_id: r.module_id,
          content_instance_id: r.content_instance_id,
          sync_mode: r.sync_mode,
        });
      } else if (orphanBlock !== null) {
        survivors.push({
          block_name: orphanBlock,
          module_id: r.module_id,
          content_instance_id: r.content_instance_id,
          sync_mode: r.sync_mode,
        });
      } else {
        droppedModules.push({ moduleId: r.module_id, formerBlock: r.block_name });
      }
    }

    await tx.execute(sql`DELETE FROM page_modules WHERE page_id = ${input.pageId}::uuid`);
    const positionByBlock = new Map<string, number>();
    for (const s of survivors) {
      const pos = positionByBlock.get(s.block_name) ?? 0;
      await tx.execute(sql`
        INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        VALUES (${input.pageId}::uuid, ${s.block_name}, ${pos}, ${s.module_id}::uuid, ${s.content_instance_id}::uuid, ${s.sync_mode})
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
      requestId: ctx.requestId,
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

// ─── v0.2.33 bulk variants ───────────────────────────────────────────

/**
 * pages.delete_many — bulk variant per CLAUDE.md §11. Soft-deletes
 * each page in a single tx; emits one snapshot per deleted page so
 * revert_site can restore the lot atomically.
 */
export const deletePagesManyOp = defineOperation({
  name: "pages.delete_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ pageIds: z.array(z.string().uuid()).min(1).max(200) }).strict(),
  output: z.object({
    deleted: z.number().int(),
    alreadyDeleted: z.number().int(),
    notFound: z.number().int(),
  }),
  handler: async (ctx, input, tx) => {
    // v0.5.7 — delegate to deletePageOp per row so bulk delete picks up
    // the v0.5.3 branched-delete + per-page-lock behaviour automatically.
    // Pre-loop check for "not found" / "already deleted" so the result
    // shape stays the same (deleted / alreadyDeleted / notFound counts).
    let deleted = 0;
    let alreadyDeleted = 0;
    let notFound = 0;
    for (const id of input.pageIds) {
      const rows = (await tx.execute(sql`
        SELECT deleted_at FROM pages WHERE id = ${id}::uuid
      `)) as unknown as { deleted_at: Date | null }[];
      const target = rows[0];
      if (!target) {
        notFound += 1;
        continue;
      }
      if (target.deleted_at !== null) {
        alreadyDeleted += 1;
        continue;
      }
      const r = await deletePageOp.handler(ctx, { pageId: id }, tx);
      if (r.ok) deleted += 1;
      // Any other error (Locked etc) falls through to the bulk caller
      // via the audit row + non-OK return on the next iteration. For
      // delete_many we keep the loop going so a single Locked row
      // doesn't kill the rest of the batch — matches update_many.
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.delete_many",
      input,
      succeeded: true,
      resultSummary: `deleted=${deleted},alreadyDeleted=${alreadyDeleted},notFound=${notFound}`,
    });
    return ok({ deleted, alreadyDeleted, notFound });
  },
});

/**
 * pages.update_many — bulk metadata edits across many pages in one tx.
 * Each item carries the same shape as pages.update (pageId + optional
 * fields). Per-item version conflicts are reported in the result;
 * the rest of the batch still applies. (Atomic-per-row, not all-or-
 * nothing — matches modules.delete_many's existing semantics.)
 */
export const updatePagesManyOp = defineOperation({
  name: "pages.update_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      updates: z.array(pageUpdateSchema).min(1).max(200),
    })
    .strict(),
  output: z.object({
    updated: z.number().int(),
    notFound: z.number().int(),
    conflicts: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
    let updated = 0;
    let notFound = 0;
    const conflicts: string[] = [];
    for (const upd of input.updates) {
      const r = await updatePageOp.handler(ctx, upd, tx);
      if (!r.ok) {
        const msg = (r.error as { message?: string }).message ?? "";
        if (msg.includes("not found") || msg.includes("deleted")) notFound += 1;
        else if (msg.includes("Conflict") || msg.includes("conflict")) conflicts.push(upd.pageId);
        else conflicts.push(upd.pageId);
        continue;
      }
      updated += 1;
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.update_many",
      input,
      succeeded: true,
      resultSummary: `updated=${updated},notFound=${notFound},conflicts=${conflicts.length}`,
    });
    return ok({ updated, notFound, conflicts });
  },
});
