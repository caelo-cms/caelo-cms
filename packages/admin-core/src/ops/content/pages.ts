// SPDX-License-Identifier: MPL-2.0

/**
 * Page Layer ops (CMS_REQUIREMENTS §3.1, §3.4). Pages reference modules
 * through `page_modules` only — the page schema has no `html` column and the
 * Validator's `.strict()` Zod rejects any `html` key, enforcing the §3.1
 * "no raw HTML on pages" invariant in code.
 */

import {
  defineOperation,
  type ErrorDetail,
  handlerErrorFromDetails,
  internalError,
  OperationAbortError,
  type QueryError,
  type TransactionRunner,
  textArray,
  uuidArray,
} from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  err,
  extractMediaRefs,
  ok,
  pageCreateSchema,
  pageSetModulesSchema,
  pageShortTitleSchema,
  pageTypeSlugSchema,
  pageUpdateSchema,
  type Result,
  redirectTargetPathSchema,
  slugSchema,
  trimSlashes,
} from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { branchVisibilityFilter, requireUsableEntity } from "../../branch.js";
import { pendingSnapshotSql } from "../../draft.js";
import { withHumanisedLinks } from "../../links/humanise.js";
import { fitPageToType, loadVocabularyIndex } from "../../lists/page-fit.js";
import { replacePageTerms } from "../../lists/page-terms.js";
import { fitIssueDetails, resolvePageTypeForWrite } from "../../lists/page-type-resolve.js";
import { loadListEntities } from "../../lists/store.js";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../../locks.js";
import {
  emitSnapshot,
  loadBranchedModuleStates,
  loadPageLayoutState,
  loadPageLayoutStateWithBranchOverlay,
  loadPageState,
  loadPageStateWithBranchOverlay,
} from "../../snapshots/index.js";
import type { PageState } from "../../snapshots/state.js";
import { buildPatchSet, buildWhere, jsonbParam } from "../../sql-helpers.js";
import { createRedirectOp } from "../redirects.js";
import { cloneContentInstancesDeep } from "./content-instance-clone.js";
import {
  composePaths,
  recomputeCurrentPaths,
  recomputeCurrentPathsWithMoves,
  renderScopeOf,
} from "./current-path.js";
import { planPageMoves } from "./page-move-plan.js";
import { executePageMoves } from "./page-moves.js";
import { ancestorIdsOf, descendantIdsOf, loadPageTree, pendingDriftIds } from "./page-tree.js";
import { applyPathMoveEffects } from "./path-moves.js";

const pageRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  /** #390 — the composed public path (pages.current_path). Under a chat
   *  branch, pages.list reports the chat's view (its pending renames /
   *  moves applied). */
  currentPath: z.string(),
  /** 0263 — the parent page (nested URLs), null at the top level. */
  parentPageId: z.string().nullable(),
  title: z.string(),
  /** #1142 — the public breadcrumb / navigation label, translated with the page. */
  shortTitle: z.string(),
  templateId: z.string(),
  /**
   * Epic #1107 — what the page IS (page type slug), in the caller's view.
   * The AI reads three modules-on-News-pages as a pattern from it
   * (CLAUDE.md §1A).
   */
  pageType: z.string(),
  pageTypeId: z.string(),
  /**
   * #1276 — false while nobody chose the page type (pages that sat on the
   * old stored default type). The `structure/unconfirmed-page-type` check
   * reports them; an update naming `pageType` confirms.
   */
  pageTypeConfirmed: z.boolean(),
  /** Property values, validated against the page type. */
  properties: z.record(z.string(), z.unknown()),
  /** Terms (`caelo:term/<listId>/<itemId>`). */
  terms: z.array(z.string()),
  /** Set by the first Publish live; null before. */
  firstPublishedAt: z.string().nullable(),
  status: z.enum(["draft", "published"]),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

const pageWithModulesSchema = pageRowSchema.extend({
  /**
   * 0184 — true when this page is the designated
   * `site_defaults.home_page_id` (the site root, served at `/`).
   * Surfaced so the current-page context can tell the AI the
   * designation explicitly instead of it guessing from the slug.
   */
  isHomePage: z.boolean(),
  /** 0284 (#802) — true when this page is `site_defaults.not_found_page_id`:
   *  the build ships it as `/404.html`, never at its own path. */
  isNotFoundPage: z.boolean(),
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
  current_path: string;
  parent_page_id: string | null;
  title: string;
  short_title: string;
  template_id: string;
  page_type_id: string;
  page_type_confirmed: boolean;
  properties: unknown;
  first_published_at: string | Date | null;
  status: "draft" | "published";
  version: number | string;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
};

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** The type-bound fields of a page row as the caller sees them. */
interface TypeBound {
  readonly pageTypeId: string;
  readonly pageType: string;
  readonly pageTypeConfirmed: boolean;
  readonly properties: Record<string, unknown>;
  readonly terms: string[];
}

/**
 * Epic #1107 — page type slug, properties and terms of `rows` in the
 * caller's view: live terms from `page_terms`, superseded by the branch's
 * newest pending page snapshot (a branched pages.update writes only the
 * snapshot), so a read after a write in the same chat shows the write.
 */
async function loadTypeBound(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  rows: readonly RawPageRow[],
): Promise<Map<string, TypeBound>> {
  const out = new Map<string, TypeBound>();
  if (rows.length === 0) return out;
  const ids = uuidArray(rows.map((r) => r.id));
  const termRows = (await tx.execute(sql`
    SELECT page_id::text AS page_id,
           'caelo:term/' || list_id::text || '/' || item_id::text AS ref
    FROM page_terms WHERE page_id = ANY(${ids})
    ORDER BY created_at, list_id, item_id
  `)) as unknown as { page_id: string; ref: string }[];
  const terms = new Map<string, string[]>();
  for (const t of termRows) terms.set(t.page_id, [...(terms.get(t.page_id) ?? []), t.ref]);
  const overlay = new Map<string, PageState>();
  if (ctx.chatBranchId) {
    const snaps = (await tx.execute(sql`
      SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS page_id, ps.state
        FROM page_snapshots ps JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
       WHERE ss.chat_branch_id = ${ctx.chatBranchId}::uuid AND ${pendingSnapshotSql()}
         AND ps.page_id = ANY(${ids})
       ORDER BY ps.page_id, ss.created_at DESC
    `)) as unknown as { page_id: string; state: unknown }[];
    for (const s of snaps) {
      overlay.set(s.page_id, s.state as PageState);
    }
  }
  const slugs = new Map(
    (
      await loadListEntities(tx, "pageType", ctx.chatBranchId ?? null, { includeDeleted: true })
    ).map((t) => [t.id, t.state.slug]),
  );
  for (const r of rows) {
    const o = overlay.get(r.id);
    const liveProps = r.properties;
    const pageTypeId = o?.pageTypeId ?? r.page_type_id;
    out.set(r.id, {
      pageTypeId,
      pageType: slugs.get(pageTypeId) ?? pageTypeId,
      pageTypeConfirmed: o?.pageTypeConfirmed ?? r.page_type_confirmed,
      properties: { ...(o?.properties ?? ((liveProps ?? {}) as Record<string, unknown>)) },
      terms: [...(o?.terms ?? terms.get(r.id) ?? [])],
    });
  }
  return out;
}

function rowToPage(r: RawPageRow, bound: TypeBound | undefined): z.infer<typeof pageRowSchema> {
  // Postgres bigint comes back as a string under bun-sql when the value would
  // overflow JS number — for our version counter (will not approach 2^53)
  // both shapes are safe to coerce.
  const version = typeof r.version === "string" ? Number.parseInt(r.version, 10) : r.version;
  const liveProps = r.properties;
  return {
    id: r.id,
    slug: r.slug,
    currentPath: r.current_path,
    parentPageId: r.parent_page_id,
    title: r.title,
    shortTitle: r.short_title,
    templateId: r.template_id,
    pageType: bound?.pageType ?? r.page_type_id,
    pageTypeId: bound?.pageTypeId ?? r.page_type_id,
    pageTypeConfirmed: bound?.pageTypeConfirmed ?? r.page_type_confirmed,
    properties: bound?.properties ?? ((liveProps ?? {}) as Record<string, unknown>),
    terms: bound?.terms ?? [],
    firstPublishedAt:
      r.first_published_at === null
        ? null
        : r.first_published_at instanceof Date
          ? r.first_published_at.toISOString()
          : String(r.first_published_at),
    status: r.status,
    version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: r.deleted_at === null ? null : iso(r.deleted_at),
  };
}

const pageListRowSchema = pageRowSchema.extend({
  /** 0263 — nesting level: 1 = top level. */
  depth: z.number().int().positive(),
});

export const listPagesOp = defineOperation({
  name: "pages.list",
  readScope: "request",
  // P6.7.3 — AI lists pages from add_module_to_template to fan a new
  // module out to every page sharing a template. Read-only.
  // #396 — plugin actors read too: deep plugins (international-site's
  // status matrix) plan against the same list surface (§11: list ops
  // are open reads).
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z.object({
    includeDeleted: z.boolean().default(false),
    /** 0263 — only the pages BELOW this page (its whole subtree). */
    underPageId: z.string().uuid().optional(),
    /**
     * #1223 — only these pages and the pages at these paths (as the
     * caller's view shows them; a trailing slash, query or fragment does
     * not count), so a plugin reading what one page renders does not
     * read the site. Both given = either matches.
     */
    pageIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
    paths: z.array(z.string().min(1).max(2048)).min(1).max(1000).optional(),
  }),
  output: z.object({ pages: z.array(pageListRowSchema) }),
  handler: async (ctx, input, tx) => {
    // v0.9.0 — branch-aware: chats see main + their own branched creates.
    const filters = [];
    if (!input.includeDeleted) filters.push(sql`pages.deleted_at IS NULL`);
    const only = pageSelectionOf(input);
    if (only) {
      // A chat's pending rename moves a page's path without touching the
      // row, so on a branch only the ids narrow the read; the paths are
      // matched on the composed view below.
      const byId = only.ids.length > 0 ? sql`pages.id = ANY(${uuidArray(only.ids)})` : null;
      const byPath =
        only.paths.size > 0
          ? sql`(CASE WHEN length(pages.current_path) > 1
                      THEN rtrim(pages.current_path, '/') ELSE pages.current_path END)
                = ANY(${textArray([...only.paths])})`
          : null;
      if (!ctx.chatBranchId || only.paths.size === 0) {
        filters.push(byId && byPath ? sql`(${byId} OR ${byPath})` : ((byId ?? byPath) as SQL));
      }
    }
    if (ctx.chatBranchId) {
      filters.push(
        sql`(pages.chat_branch_id IS NULL OR pages.chat_branch_id = ${ctx.chatBranchId}::uuid)`,
      );
    } else {
      filters.push(sql`pages.chat_branch_id IS NULL`);
    }
    const rows = (await tx.execute(sql`
      SELECT pages.id::text AS id, pages.slug, pages.current_path,
             pages.parent_page_id::text AS parent_page_id, pages.title, pages.short_title,
             pages.template_id::text AS template_id,
             pages.page_type_id::text AS page_type_id, pages.page_type_confirmed,
             pages.properties, pages.first_published_at,
             pages.status, pages.version,
             pages.created_at, pages.updated_at, pages.deleted_at
      FROM pages
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
         WHERE ss.chat_branch_id = ${ctx.chatBranchId}::uuid AND ${pendingSnapshotSql()}
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
          const s = rawState as {
            slug?: string;
            parentPageId?: string | null;
            title?: string;
            shortTitle?: string;
            templateId?: string;
            status?: "draft" | "published";
            version?: number;
            deletedAt?: string | null;
          };
          if (s.deletedAt && !input.includeDeleted) continue;
          merged.push({
            ...row,
            slug: s.slug ?? row.slug,
            parent_page_id: s.parentPageId === undefined ? row.parent_page_id : s.parentPageId,
            title: s.title ?? row.title,
            short_title: s.shortTitle ?? row.short_title,
            template_id: s.templateId ?? row.template_id,
            status: s.status ?? row.status,
            version: s.version ?? row.version,
            deleted_at: s.deletedAt ?? row.deleted_at,
          });
        }
        const bound = await loadTypeBound(tx, ctx, merged);
        return ok({
          pages: await withTreeView(
            tx,
            ctx,
            merged.map((r) => rowToPage(r, bound.get(r.id))),
            input.underPageId,
            only,
          ),
        });
      }
    }
    const bound = await loadTypeBound(tx, ctx, rows);
    return ok({
      pages: await withTreeView(
        tx,
        ctx,
        rows.map((r) => rowToPage(r, bound.get(r.id))),
        input.underPageId,
        only,
      ),
    });
  },
});

/**
 * 0263 — the tree half of pages.list: depth per page, the subtree
 * filter, and — under a chat branch — the chat's view of every path its
 * pending renames / moves change (the live `current_path` of a main page
 * only moves at publish). Deleted rows (includeDeleted) keep depth 1:
 * they are not part of the live tree.
 */
async function withTreeView(
  tx: Parameters<NonNullable<(typeof createRedirectOp)["handler"]>>[2],
  ctx: ExecutionContext,
  pages: z.infer<typeof pageRowSchema>[],
  underPageId: string | undefined,
  only: PageSelection | null = null,
): Promise<z.infer<typeof pageListRowSchema>[]> {
  const tree = await loadPageTree(tx, ctx.chatBranchId ?? null);
  let visible = pages;
  if (underPageId !== undefined) {
    const below = new Set(descendantIdsOf(tree, [underPageId]));
    visible = pages.filter((p) => below.has(p.id));
  }
  let branchPaths = new Map<string, string>();
  if (ctx.chatBranchId) {
    // Pages this chat renamed or moved (pending — main pages and its own
    // alike), plus everything below them: their stored path predates the
    // pending change.
    const drifted = await pendingDriftIds(tx, tree, ctx.chatBranchId);
    if (drifted.length > 0) {
      branchPaths = await composePaths(tx, tree, drifted, renderScopeOf(ctx));
    }
  }
  const out = visible.map((p) => ({
    ...p,
    currentPath: branchPaths.get(p.id) ?? p.currentPath,
    depth: tree.byId.has(p.id) ? ancestorIdsOf(tree, p.id).length + 1 : 1,
  }));
  if (only === null) return out;
  const ids = new Set(only.ids);
  return out.filter((p) => ids.has(p.id) || only.paths.has(normalisedPath(p.currentPath)));
}

/** The `pageIds` / `paths` filter of pages.list (#1223). */
interface PageSelection {
  readonly ids: readonly string[];
  /** Normalised by {@link normalisedPath}. */
  readonly paths: ReadonlySet<string>;
}

function pageSelectionOf(input: {
  readonly pageIds?: readonly string[] | undefined;
  readonly paths?: readonly string[] | undefined;
}): PageSelection | null {
  if (input.pageIds === undefined && input.paths === undefined) return null;
  return { ids: input.pageIds ?? [], paths: new Set((input.paths ?? []).map(normalisedPath)) };
}

/** A path without query, fragment or trailing slash ("/" stays "/"). */
function normalisedPath(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? path;
  return bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
}

export const getPageOp = defineOperation({
  name: "pages.get",
  readScope: "request",
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
      SELECT id::text AS id, slug, current_path, parent_page_id::text AS parent_page_id,
             title, short_title, template_id::text AS template_id,
             page_type_id::text AS page_type_id, page_type_confirmed, properties, first_published_at,
             status, version, created_at, updated_at, deleted_at
      FROM pages WHERE id = ${input.pageId}::uuid ${branchFilter} LIMIT 1
    `)) as unknown as RawPageRow[];
    const row = rows[0];
    if (!row) {
      return err({ kind: "HandlerError", operation: "pages.get", message: "page not found" });
    }
    const bound = await loadTypeBound(tx, ctx, [row]);
    return ok({ page: rowToPage(row, bound.get(row.id)) });
  },
});

/**
 * Returns the page row plus its modules grouped by block, in `position` order.
 * Two queries + Map merge — same shape as `users.list` from P2 — is simpler
 * to reason about than a json-aggregating SQL.
 */
export const getPageWithModulesOp = withHumanisedLinks(
  defineOperation({
    name: "pages.get_with_modules",
    readScope: "request",
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
      SELECT id::text AS id, slug, current_path, parent_page_id::text AS parent_page_id,
             title, short_title, template_id::text AS template_id,
             page_type_id::text AS page_type_id, page_type_confirmed, properties, first_published_at,
             status, version, created_at, updated_at, deleted_at
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
          WHERE ss.chat_branch_id = ${ctx.chatBranchId}::uuid AND ${pendingSnapshotSql()}
            AND ms.module_id = ANY(${sql.raw(
              `ARRAY[${allModuleIds.map((id) => `'${id}'::uuid`).join(",")}]`,
            )})
          ORDER BY ms.module_id, ss.created_at DESC
        `)) as unknown as { module_id: string; state: unknown }[];
          for (const row of overlayRows) {
            const detail = detailById.get(row.module_id);
            if (!detail) continue;
            const s = row.state as {
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
          pageRow.short_title = pageState.shortTitle;
        }
      }
      // 0184 — is this page the designated homepage (site root)?
      // 0284 (#802) — or the designated 404 page?
      const designationRows = (await tx.execute(sql`
      SELECT (home_page_id = ${input.pageId}::uuid) AS is_home,
             (not_found_page_id = ${input.pageId}::uuid) AS is_not_found
      FROM site_defaults
      WHERE id = 1
      LIMIT 1
    `)) as unknown as { is_home: boolean | null; is_not_found: boolean | null }[];
      const isHomePage = designationRows[0]?.is_home === true;
      const isNotFoundPage = designationRows[0]?.is_not_found === true;
      const bound = await loadTypeBound(tx, ctx, [pageRow]);
      return ok({
        page: {
          ...rowToPage(pageRow, bound.get(pageRow.id)),
          isHomePage,
          isNotFoundPage,
          blocks: orderedBlocks,
        },
      });
    },
  }),
);

/**
 * A page's slug is "root-equivalent" (serves at the site root `/`) when
 * it is the magic sentinel (""/`home`/`index`) — the back-compat path — OR
 * when it is the explicitly designated `site_defaults.home_page_id`
 * (0184). The duplicate-URL backstop treats every root-equivalent page
 * as occupying the same `/`, so the site can only ever have ONE homepage.
 */
function isRootSlug(slug: string): boolean {
  const s = trimSlashes(slug);
  return s === "" || s === "home" || s === "index";
}

/**
 * The set of candidate page ids that are soft-deleted ON THE CURRENT CHAT
 * BRANCH. A branched `pages.delete` never touches the live row — it emits a
 * `page_snapshots` row with `state.deletedAt` set (v0.5.3) — so a live-row
 * scan alone would treat a page the chat just deleted as still occupying
 * its slug/URL. This overlay lets the create-time uniqueness check ignore
 * pages the caller reclaimed on its own branch (2b).
 */
async function branchDeletedPageIds(
  tx: Parameters<NonNullable<(typeof createRedirectOp)["handler"]>>[2],
  chatBranchId: string,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  const deleted = new Set<string>();
  if (candidateIds.length === 0) return deleted;
  const overlay = (await tx.execute(sql`
    SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS page_id, ps.state
      FROM page_snapshots ps
      JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
     WHERE ss.chat_branch_id = ${chatBranchId}::uuid AND ${pendingSnapshotSql()}
       AND ps.page_id = ANY(${sql.raw(
         `ARRAY[${candidateIds.map((id) => `'${id}'::uuid`).join(",")}]`,
       )})
     ORDER BY ps.page_id, ss.created_at DESC
  `)) as unknown as { page_id: string; state: unknown }[];
  for (const row of overlay) {
    const s = row.state as {
      deletedAt?: string | null;
    };
    if (s.deletedAt) deleted.add(row.page_id);
  }
  return deleted;
}

export const createPageOp = defineOperation({
  name: "pages.create",
  readScope: "request",
  // P6.7.5 — AI reaches this op via the `build_page` tool. Validator + audit
  // + snapshot all run in the same path as a human create.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: pageCreateSchema,
  output: z.object({ pageId: z.string() }),
  handler: async (ctx, input, tx) => {
    // Epic #1107 — the page type and template, decided deterministically
    // (lists/page-type-resolve.ts): `pageType` named, else the one type
    // listing `templateId`, else the stored site defaults (P6.7.6 — never a
    // silent fallback; a missing default is a structured error).
    if (input.templateId !== undefined) {
      const tplExists = (await tx.execute(sql`
        SELECT 1 FROM templates WHERE id = ${input.templateId}::uuid AND deleted_at IS NULL LIMIT 1
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
    }
    const resolved = await resolvePageTypeForWrite(tx, ctx.chatBranchId ?? null, {
      ...(input.pageType !== undefined ? { pageType: input.pageType } : {}),
      ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
    });
    if (!resolved.ok) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "pages.create",
        input,
        succeeded: false,
        resultSummary: "page-type-unresolved",
      });
      return err(handlerErrorFromDetails("pages.create", [resolved.detail]));
    }
    const templateId = resolved.templateId;
    const fit = fitPageToType(
      resolved.def,
      { templateId, properties: input.properties ?? {}, terms: input.terms ?? [] },
      await loadVocabularyIndex(tx, ctx.chatBranchId ?? null, [resolved.def]),
    );
    if (fit.issues.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "pages.create",
        input,
        succeeded: false,
        resultSummary: "page-type-mismatch",
      });
      return err(
        handlerErrorFromDetails("pages.create", fitIssueDetails(resolved.def.slug, fit.issues), {
          lead: `The page does not fit page type "${resolved.def.slug}":`,
        }),
      );
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
    if (input.templateId === undefined) {
      const resolvedTpl = (await tx.execute(sql`
        SELECT 1 FROM templates WHERE id = ${templateId}::uuid AND deleted_at IS NULL LIMIT 1
      `)) as unknown as { exists: number }[];
      if (resolvedTpl.length === 0) {
        return err({
          kind: "HandlerError",
          operation: "pages.create",
          message: `template ${templateId} (the default template of page type "${resolved.def.slug}") is deleted — pass templateId, and repair the type's defaultTemplate with page_types.upsert_many.`,
        });
      }
    }
    // v0.9.0 + 1b/2b — same-branch public-URL uniqueness with
    // root-equivalence + branch-delete awareness. This subsumes the old
    // exact-slug check AND adds the structural "two homepages" guard: a
    // magic slug (""/`home`/`index`) and the designated
    // `site_defaults.home_page_id` ALL resolve to `/`, so a second page that also
    // resolves to `/` is rejected with a pointer at the existing one
    // (1b). Branches keep their own slug namespace (migration 0089), so
    // the check is scoped to the caller's branch namespace; a page the
    // caller soft-deleted on its OWN branch no longer occupies its
    // slug/URL, so the slug can be reclaimed (2b).
    const pageDupNamespace = ctx.chatBranchId ?? "00000000-0000-0000-0000-000000000000";
    const homeRows = (await tx.execute(sql`
      SELECT home_page_id::text AS home_page_id FROM site_defaults WHERE id = 1 LIMIT 1
    `)) as unknown as { home_page_id: string | null }[];
    const homePageId = homeRows[0]?.home_page_id ?? null;
    const candidates = (await tx.execute(sql`
      SELECT id::text AS id, slug, (parent_page_id IS NOT NULL) AS nested FROM pages
      WHERE deleted_at IS NULL
        AND COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid) = ${pageDupNamespace}::uuid
    `)) as unknown as { id: string; slug: string; nested: boolean }[];
    const branchDeleted = ctx.chatBranchId
      ? await branchDeletedPageIds(
          tx,
          ctx.chatBranchId,
          candidates.map((c) => c.id),
        )
      : new Set<string>();
    // A NEW page can only be root-equivalent via a magic slug — it has no
    // row yet, so it can't be the designated home_page_id.
    // A nested page is never the root, whatever its slug ("/docs/index").
    const newIsRoot = !input.parentPageId && isRootSlug(input.slug);
    // The root ("/") stays a one-page slot; every other clash is a URL
    // clash, checked on composed paths by the planner below (0264: the
    // same slug may live under different parents / prefixes).
    const conflict = candidates.find((c) => {
      if (branchDeleted.has(c.id)) return false;
      // A nested magic slug ("/docs/index") is just a segment, never "/".
      const candIsRoot =
        (!c.nested && isRootSlug(c.slug)) || (homePageId !== null && c.id === homePageId);
      return newIsRoot && candIsRoot;
    });
    if (conflict) {
      const conflictIsRoot =
        (!conflict.nested && isRootSlug(conflict.slug)) ||
        (homePageId !== null && conflict.id === homePageId);
      const bothRoot = newIsRoot && conflictIsRoot;
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "pages.create",
        input,
        succeeded: false,
        resultSummary: bothRoot ? "root-url-conflict" : "slug-conflict",
      });
      return err({
        kind: "HandlerError",
        operation: "pages.create",
        message: bothRoot
          ? `the site root (/) is already served by page ${conflict.id} (slug="${conflict.slug}") — the site has exactly ONE homepage. Edit that page instead (build_page with its pageId), or give this page a non-root slug.`
          : `page already exists at slug="${input.slug}" — it is page ${conflict.id}. Edit it (build_page with its pageId) instead of creating a duplicate.`,
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
    //
    // Status resolution: an explicit `status` always wins. When omitted
    // (the AI's create_page rarely sets it), a BOOTSTRAP site — zero LIVE
    // published pages (chat_branch_id IS NULL) — publishes the page so the
    // first Stage has something to serve; every later create drafts for
    // review. Without this, a fresh homepage stayed `draft` and the first
    // Stage failed with "0 published pages for env='staging'". "Live"
    // (chat_branch_id IS NULL) is deliberate: a page still in this chat's
    // branch isn't what staging serves, so it doesn't count as bootstrapped
    // yet. No silent read-time fallback — this resolves a stored value at
    // write time (CLAUDE.md §2).
    // 0263 — a page created under a parent: same structural rules and
    // URL-conflict check as a move (depth, homepage-as-parent, path
    // taken), planned in the caller's branch view before the INSERT.
    const parentPageId = input.parentPageId ?? null;
    // The planned composed path goes into the INSERT: the trigger's
    // plugin-free default could transiently collide with a page that
    // shares the slug elsewhere (a prefixed or nested sibling).
    let plannedPath: string | null = null;
    if (!newIsRoot) {
      const tempId = crypto.randomUUID();
      const plan = await planPageMoves(tx, renderScopeOf(ctx), [
        { pageId: tempId, isNew: true, parentPageId, newSlug: input.slug },
      ]);
      if (!plan.ok) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: "pages.create",
          input,
          succeeded: false,
          resultSummary: "plan-refused",
        });
        return err({ kind: "HandlerError", operation: "pages.create", message: plan.message });
      }
      plannedPath = plan.plan.pathsAfter.get(tempId) ?? null;
    }
    let resolvedStatus = input.status;
    if (resolvedStatus === undefined) {
      const pub = (await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM pages
          WHERE status = 'published' AND deleted_at IS NULL AND chat_branch_id IS NULL
        ) AS has_published
      `)) as unknown as { has_published: boolean }[];
      resolvedStatus = pub[0]?.has_published ? "draft" : "published";
    }
    const rows = (await tx.execute(sql`
      INSERT INTO pages (slug, title, short_title, template_id, status, chat_branch_id, parent_page_id, current_path,
                         page_type_id, page_type_confirmed, properties)
      VALUES (
        ${input.slug},
        ${input.title},
        ${input.shortTitle ?? input.title},
        ${templateId}::uuid,
        ${resolvedStatus},
        ${ctx.chatBranchId ?? null}::uuid,
        ${parentPageId}::uuid,
        ${plannedPath},
        ${resolved.typeId}::uuid,
        true,
        ${jsonbParam(fit.properties)}
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const pageId = rows[0]?.id;
    if (!pageId) {
      return err(internalError("pages.create", "the page insert returned no id"));
    }
    // The page's row data — on a branch the row (and so its terms) is
    // invisible to everyone else until the merge graduates it.
    await replacePageTerms(tx, pageId, fit.terms);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.create",
      input,
      succeeded: true,
      entityId: pageId,
      resultSummary: `slug=${input.slug}`,
    });
    const state = await loadPageState(tx, pageId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "pages.create",
        description: `pages.create slug=${input.slug}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "page", entityId: pageId, state }],
      });
    }
    // #390 — compose + materialize the public path (the INSERT trigger
    // wrote the plugin-free default; this accounts for designation +
    // active URL contributions).
    await recomputeCurrentPaths(tx, [pageId], renderScopeOf(ctx));
    return ok({ pageId });
  },
});

export const updatePageOp = defineOperation({
  name: "pages.update",
  readScope: "request",
  // #397 — plugin actors update too (the translator writes the
  // variant's translated title).
  // P6.7.5 / #1142 — the identifiers (title / short title / slug) are
  // separate optional fields so a caller can never silently substitute one
  // for another. A `slug`
  // change additionally fires the URL side-effects (301, chain collapse) in
  // this same transaction — see applyPathMoveEffects (path-moves.ts).
  actorScope: ["human", "ai", "plugin", "system"],
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
      holderKey: ctx.chatTaskId,
    });
    if (!lock.permitted) {
      return err(await entityWriteBlockedError(tx, "pages.update", "page", input.pageId, lock));
    }
    // v0.5.3 — branched update path. When ctx.chatBranchId is set we
    // skip the live UPDATE and emit a branched snapshot carrying the
    // post-patch state, mirroring modules.update's v0.5.1 pattern.
    const branched = !!ctx.chatBranchId;
    const existingRows = (await tx.execute(sql`
      SELECT version, slug, title, template_id::text AS template_id, status, deleted_at
      FROM pages WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as {
      version: number | string;
      slug: string;
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
      // 0264 — a rename moves the page's URL and its whole subtree's:
      // refuse any new URL another page already has, in the caller's
      // branch view (a page this chat deleted no longer holds its URL).
      const plan = await planPageMoves(tx, renderScopeOf(ctx), [
        { pageId: input.pageId, newSlug: input.slug },
      ]);
      if (!plan.ok) {
        return err({ kind: "HandlerError", operation: "pages.update", message: plan.message });
      }
    }

    // Epic #1107 — page type, properties, terms. The type stays unless
    // `pageType` names another or the new template belongs to another
    // type only; the result must fit the type (template allowed,
    // properties valid, terms from its vocabularies).
    const typeBase = branched
      ? await loadPageStateWithBranchOverlay(tx, input.pageId, ctx.chatBranchId)
      : await loadPageState(tx, input.pageId);
    if (!typeBase) {
      return err({ kind: "HandlerError", operation: "pages.update", message: "page not found" });
    }
    const typeBound = await nextTypeBound(tx, ctx, input, typeBase);
    if (!typeBound.ok) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "pages.update",
        input,
        succeeded: false,
        entityId: input.pageId,
        resultSummary: "page-type-mismatch",
      });
      return err(handlerErrorFromDetails("pages.update", typeBound.details));
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
      // A pending rename remembers "no 301s" for the publish that makes
      // it live; any other edit keeps whatever the last rename asked.
      const { pendingRedirects: prevRedirects, ...baseState } = base;
      const pendingRedirects =
        input.slug !== undefined && input.slug !== base.slug
          ? input.redirectFromOld === "skip"
            ? "skip"
            : undefined
          : prevRedirects;
      state = {
        ...baseState,
        ...(pendingRedirects ? { pendingRedirects } : {}),
        slug: input.slug ?? base.slug,
        title: input.title ?? base.title,
        shortTitle: input.shortTitle ?? base.shortTitle,
        templateId: input.templateId ?? base.templateId,
        status: input.status ?? base.status,
        version: currentVersion + 1,
        deletedAt: null,
        pageTypeId: typeBound.pageTypeId,
        pageTypeConfirmed: typeBound.pageTypeConfirmed,
        properties: typeBound.properties,
        terms: typeBound.terms,
      };
    } else {
      const sets = buildPatchSet({
        title: input.title,
        short_title: input.shortTitle,
        slug: input.slug,
        template_id: input.templateId !== undefined ? sql`${input.templateId}::uuid` : undefined,
        status: input.status,
        page_type_id: sql`${typeBound.pageTypeId}::uuid`,
        page_type_confirmed: typeBound.pageTypeConfirmed,
        properties: sql`${jsonbParam(typeBound.properties)}`,
        version: sql`version + 1`,
      });
      await tx.execute(sql`
        UPDATE pages SET ${sets} WHERE id = ${input.pageId}::uuid
      `);
      if (JSON.stringify(typeBound.terms) !== JSON.stringify(typeBase.terms)) {
        await replacePageTerms(tx, input.pageId, typeBound.terms);
      }
      // The URL moved — for this page AND every page below it (a parent's
      // path prefixes its children's). Keep the old URLs alive and drag
      // every link along, in THIS transaction; every caller of
      // pages.update (incl. update_many) inherits it.
      if (input.slug !== undefined && input.slug !== existing.slug) {
        const recomputed = await recomputeCurrentPathsWithMoves(
          tx,
          [input.pageId],
          renderScopeOf(ctx),
        );
        await applyPathMoveEffects(ctx, tx, recomputed.moves, input.redirectFromOld ?? "auto");
      }
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
 * Epic #1107 — the page type, properties and terms a pages.update leaves
 * the page with, checked against the (possibly new) page type. Properties
 * merge (`null` removes one); `terms` replaces. #1276: the type counts as
 * chosen once a write names `pageType` (also the current one — that is
 * how a page on the old default type gets confirmed) or moves the page to
 * another type through its template; otherwise the flag is kept.
 */
async function nextTypeBound(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  input: z.infer<typeof pageUpdateSchema>,
  base: PageState,
): Promise<
  | {
      ok: true;
      pageTypeId: string;
      pageTypeConfirmed: boolean;
      properties: Record<string, unknown>;
      terms: string[];
    }
  | { ok: false; details: ErrorDetail[] }
> {
  const resolved = await resolvePageTypeForWrite(tx, ctx.chatBranchId ?? null, {
    ...(input.pageType !== undefined ? { pageType: input.pageType } : {}),
    ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
    current: { pageTypeId: base.pageTypeId, templateId: base.templateId },
  });
  if (!resolved.ok) return { ok: false, details: [resolved.detail] };
  const properties: Record<string, unknown> = { ...base.properties };
  for (const [k, v] of Object.entries(input.properties ?? {})) {
    if (v === null) delete properties[k];
    else properties[k] = v;
  }
  const fit = fitPageToType(
    resolved.def,
    {
      templateId: input.templateId ?? base.templateId,
      properties,
      terms: input.terms ?? base.terms,
    },
    await loadVocabularyIndex(tx, ctx.chatBranchId ?? null, [resolved.def]),
  );
  if (fit.issues.length > 0) {
    return { ok: false, details: fitIssueDetails(resolved.def.slug, fit.issues) };
  }
  return {
    ok: true,
    pageTypeId: resolved.typeId,
    pageTypeConfirmed:
      input.pageType !== undefined || resolved.typeId !== base.pageTypeId || base.pageTypeConfirmed,
    properties: fit.properties,
    terms: fit.terms,
  };
}

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
 *   2. When the active chat's branch has pending state for the page,
 *      record the new status as a NEW page snapshot on it (see
 *      {@link recordBranchedStatus}). Without it, `chat.merge_to_main`
 *      would UPSERT the live row from a stale snapshot at Stage and
 *      revert the status.
 */
/**
 * Record a status flip on the caller's branch as the CALLER's change: for
 * every page the branch has pending state for, a new page snapshot (that
 * state with the new status) under the caller's chat task. Patching the
 * latest snapshot in place — the earlier approach — rewrote whichever
 * chat wrote it last: on the shared draft that is often another chat, so
 * its pending change silently carried this chat's status (wrong
 * attribution, and undoing this chat could not restore the old status).
 * Pages the branch has no pending state for need nothing: a merge does
 * not upsert a page it has no snapshot for, so the live status stands.
 */
async function recordBranchedStatus(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  ctx: ExecutionContext,
  pageIds: readonly string[],
  status: "draft" | "published",
  operation: "pages.set_status" | "pages.set_status_many",
): Promise<void> {
  if (!ctx.chatBranchId || pageIds.length === 0) return;
  const latest = (await tx.execute(sql`
    SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS page_id, ps.state
      FROM page_snapshots ps
      JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
     WHERE ps.page_id = ANY(${uuidArray(pageIds)})
       AND ss.chat_branch_id = ${ctx.chatBranchId}::uuid AND ${pendingSnapshotSql()}
     ORDER BY ps.page_id, ss.created_at DESC
  `)) as unknown as { page_id: string; state: unknown }[];
  if (latest.length === 0) return;
  const entities = latest.map((row) => {
    const prior = row.state as PageState;
    return { kind: "page" as const, entityId: row.page_id, state: { ...prior, status } };
  });
  await emitSnapshot(tx, {
    actorId: ctx.actorId,
    opKind: "pages.update",
    description: `${operation} status=${status} pages=${entities.length} (branched)`,
    chatTaskId: ctx.chatTaskId ?? null,
    chatBranchId: ctx.chatBranchId,
    entities,
  });
}

export const setPageStatusOp = defineOperation({
  name: "pages.set_status",
  readScope: "request",
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

    await recordBranchedStatus(tx, ctx, [input.pageId], input.status, "pages.set_status");

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
  readScope: "request",
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

    await recordBranchedStatus(
      tx,
      ctx,
      updated.map((r) => r.id),
      input.status,
      "pages.set_status_many",
    );

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
  readScope: "request",
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
      holderKey: ctx.chatTaskId,
    });
    if (!setModulesLock.permitted) {
      return err(
        await entityWriteBlockedError(
          tx,
          "pages.set_modules",
          "page",
          input.pageId,
          setModulesLock,
        ),
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
        WHERE id = ANY(${uuidArray(allModuleIds)}) AND deleted_at IS NULL
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
    // Read the current state so surviving placements KEEP their content
    // bindings. Two hard-won rules (live-edit run B, module-ref-malformed
    // → max_loops crash):
    //  1. Priors come from the BRANCH-OVERLAID layout, not live
    //     page_modules — a chat's placements live only in
    //     page_layout_snapshots, so the live read returned NOTHING for
    //     branched callers and every set_modules re-minted EVERY
    //     instance (wiping all content the chat had authored).
    //  2. Matching is a per-(block, module) FIFO QUEUE, not exact
    //     position: removing/reordering an earlier placement shifts the
    //     survivors' positions, and position-strict matching treated the
    //     shifted survivor as "new" — minting it a fresh EMPTY instance
    //     and orphaning its authored content (the nested-CTA `cta` value
    //     vanished mid-turn exactly this way).
    const priorLayout = await loadPageLayoutStateWithBranchOverlay(
      tx,
      input.pageId,
      ctx.chatBranchId ?? null,
    );
    const priorQueues = new Map<
      string,
      { contentInstanceId: string; syncMode: "synced" | "unsynced" }[]
    >();
    for (const block of priorLayout.blocks) {
      for (const p of block.placements ?? []) {
        const key = `${block.blockName}#${p.moduleId}`;
        const q = priorQueues.get(key) ?? [];
        q.push({ contentInstanceId: p.contentInstanceId, syncMode: p.syncMode });
        priorQueues.set(key, q);
      }
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
    // #1195 — placements addressed by their content instance. Each must be
    // one of this page's placements of the same module. Placements may share
    // a content instance (placement.set_content allows it), so an id can be
    // named as often as the page has placements bound to it — each name
    // claims one of them, with that placement's sync mode. Claimed ones are
    // skipped by the FIFO pass below so no binding is handed out twice.
    type PriorBinding = { moduleId: string; syncMode: "synced" | "unsynced" };
    const priorById = new Map<string, PriorBinding[]>();
    for (const block of priorLayout.blocks) {
      for (const p of block.placements ?? []) {
        const list = priorById.get(p.contentInstanceId) ?? [];
        list.push({ moduleId: p.moduleId, syncMode: p.syncMode });
        priorById.set(p.contentInstanceId, list);
      }
    }
    const claimedSyncModes = new Map<string, ("synced" | "unsynced")[]>();
    const claims = new Map<string, number>();
    for (const block of input.blocks) {
      for (const [i, ciId] of (block.contentInstanceIds ?? []).entries()) {
        if (ciId === null) continue;
        const moduleId = block.moduleIds[i] as string;
        const prior = priorById.get(ciId);
        const used = claims.get(ciId) ?? 0;
        const problem =
          prior === undefined
            ? `content instance ${ciId} is not a placement on this page`
            : (prior[0] as PriorBinding).moduleId !== moduleId
              ? `content instance ${ciId} belongs to module ${(prior[0] as PriorBinding).moduleId}, not ${moduleId}`
              : used >= prior.length
                ? `content instance ${ciId} is named ${used + 1} times but bound to ${prior.length} placement(s) on this page`
                : null;
        if (problem !== null) {
          return err({
            kind: "HandlerError",
            operation: "pages.set_modules",
            message: `${problem} — pages.get_with_modules lists the page's placements (block, module, contentInstanceId).`,
          });
        }
        claims.set(ciId, used + 1);
        const modes = claimedSyncModes.get(ciId) ?? [];
        modes.push((prior as PriorBinding[])[used]?.syncMode ?? "unsynced");
        claimedSyncModes.set(ciId, modes);
      }
    }
    // Remaining claims per id: the FIFO pass skips that many queue entries
    // bound to it, since the named placements took those bindings.
    const toSkip = new Map(claims);

    const resolved: ResolvedPlacement[] = [];
    for (const block of input.blocks) {
      let position = 0;
      for (const [index, moduleId] of block.moduleIds.entries()) {
        const named = block.contentInstanceIds?.[index] ?? null;
        // A named placement keeps its own binding; otherwise consume the
        // next surviving binding for this (block, module) — FIFO keeps
        // repeated placements of the same module in their relative order
        // while tolerating position shifts — skipping reserved ones.
        const queue = priorQueues.get(`${block.blockName}#${moduleId}`) ?? [];
        let prior: { contentInstanceId: string; syncMode: "synced" | "unsynced" } | undefined;
        if (named !== null) {
          prior = {
            contentInstanceId: named,
            syncMode: (claimedSyncModes.get(named) as ("synced" | "unsynced")[]).shift() as
              | "synced"
              | "unsynced",
          };
        } else {
          for (;;) {
            const head = queue[0];
            const skip = head ? (toSkip.get(head.contentInstanceId) ?? 0) : 0;
            if (!head || skip === 0) break;
            toSkip.set(head.contentInstanceId, skip - 1);
            queue.shift();
          }
          prior = queue.shift();
        }
        let contentInstanceId: string;
        let syncMode: "synced" | "unsynced";
        if (prior) {
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
    return ok({});
  },
});

/**
 * 0263 — what deleting a page does to its child pages: `refuse` (the
 * default — the operator decides), `move-up` (they move to the deleted
 * page's parent, old URLs 301) or `delete` (the whole subtree goes, with
 * the same disposition).
 */
const pageDeleteChildrenSchema = z.enum(["refuse", "move-up", "delete"]);

const deletePageInputSchema = z
  .object({
    pageId: z.string().uuid(),
    disposition: z.enum(["404", "redirect"]).optional(),
    redirectTo: redirectTargetPathSchema.optional(),
    children: pageDeleteChildrenSchema.optional(),
  })
  .refine((v) => v.disposition !== "redirect" || !!v.redirectTo, {
    message: "disposition 'redirect' requires redirectTo",
  });

/**
 * pages.delete's body — a named function with an explicit return type so
 * the `children: "delete"` cascade can recurse into it.
 */
async function deletePageHandler(
  ctx: ExecutionContext,
  input: z.infer<typeof deletePageInputSchema>,
  tx: TransactionRunner,
): Promise<Result<Record<string, never>, QueryError>> {
  const deleteLock = await checkAndAcquireEntityLock(tx, {
    kind: "page",
    entityId: input.pageId,
    chatBranchId: ctx.chatBranchId,
    holderKey: ctx.chatTaskId,
  });
  if (!deleteLock.permitted) {
    return err(await entityWriteBlockedError(tx, "pages.delete", "page", input.pageId, deleteLock));
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
  // 0263 — a page with child pages: their URLs hang off this one.
  // Refuse by default (the operator decides what happens to them), or
  // move them up / delete them first when the caller said so.
  const tree = await loadPageTree(tx, ctx.chatBranchId ?? null);
  const kids = tree.childrenOf.get(input.pageId) ?? [];
  if (kids.length > 0) {
    const mode = input.children ?? "refuse";
    if (mode === "refuse") {
      const paths = await composePaths(tx, tree, kids.slice(0, 5), renderScopeOf(ctx));
      return err({
        kind: "HandlerError",
        operation: "pages.delete",
        message: `page ${input.pageId} has ${kids.length} child page(s) (${[...paths.values()].join(", ")}${kids.length > 5 ? ", …" : ""}). Decide what happens to them: move them elsewhere first (move_pages), or delete again with children: "move-up" (they move to this page's parent, old URLs 301) or children: "delete" (the whole subtree is deleted with the same disposition).`,
      });
    }
    if (mode === "move-up") {
      const parentOfDeleted = tree.byId.get(input.pageId)?.parentPageId ?? null;
      const moved = await executePageMoves(
        ctx,
        tx,
        kids.map((k) => ({ pageId: k, parentPageId: parentOfDeleted })),
        "auto",
      );
      if (!moved.ok) return err(moved.error);
    } else {
      for (const k of kids) {
        const r = await deletePageHandler(
          ctx,
          {
            pageId: k,
            disposition: input.disposition,
            redirectTo: input.redirectTo,
            children: "delete",
          },
          tx,
        );
        // Earlier siblings may already be deleted on this tx: a plain
        // err would commit that partial subtree delete. Abort it whole.
        if (!r.ok) throw new OperationAbortError(r.error);
      }
    }
  }
  // v0.5.3 — branched: skip live soft-delete; emit branched snapshot
  // with deletedAt set so preview hides the page in the caller's chat.
  const branched = !!ctx.chatBranchId;
  let state: import("../../snapshots/state.js").PageState | null;
  if (branched) {
    const prev = (await tx.execute(sql`
      SELECT slug, title, template_id::text AS template_id, status, version,
             chat_branch_id::text AS chat_branch_id
      FROM pages WHERE id = ${input.pageId}::uuid LIMIT 1
    `)) as unknown as {
      slug: string;
      title: string;
      template_id: string;
      status: "draft" | "published";
      version: number | string;
      chat_branch_id: string | null;
    }[];
    const p = prev[0];
    // The chat's own pending view of the page (a rename or move it made
    // earlier) is what gets deleted — not the live row's.
    const base = await loadPageStateWithBranchOverlay(tx, input.pageId, ctx.chatBranchId);
    state = base ? { ...base, deletedAt: new Date().toISOString() } : null;
    // 2b — a page CREATED on THIS branch (its live row is branch-owned:
    // invisible to other chats + to static-gen) frees its slug/URL
    // immediately by soft-deleting the live row too. Without this the
    // (slug, branch) partial UNIQUE INDEX
    // (`pages_slug_branch_uidx`, migration 0201) — which only
    // ignores rows WHERE deleted_at IS NULL — keeps counting the still-
    // live row, so the same chat can't reclaim the slug it just deleted.
    // A MAIN page (chat_branch_id NULL) deleted on a branch is left
    // untouched on purpose: that delete stays branch-scoped until
    // publish, where merge propagates state.deletedAt to the live row.
    if (p && p.chat_branch_id !== null && p.chat_branch_id === ctx.chatBranchId) {
      await tx.execute(sql`UPDATE pages SET deleted_at = now() WHERE id = ${input.pageId}::uuid`);
    }
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
  // Dead-URL redirect, on this tx. `state` carries the page's slug
  // (delete doesn't change it). A failed 301 aborts the delete rather than
  // leaving the URL silently unredirected (§2 no-fallbacks).
  if (input.disposition === "redirect" && state) {
    // #390 — the composed path (prefixes included) is the URL that
    // needs the 301, not the bare slug shape.
    const pathRows = (await tx.execute(sql`
      SELECT current_path FROM pages WHERE id = ${input.pageId}::uuid
    `)) as unknown as { current_path: string }[];
    const oldPath = pathRows[0]?.current_path;
    if (oldPath === undefined) {
      throw new Error(`page delete aborted — page ${input.pageId} has no current_path`);
    }
    const red = await createRedirectOp.handler(
      ctx,
      { fromPath: oldPath, toPath: input.redirectTo as string, statusCode: 301 },
      tx,
    );
    if (!red.ok) {
      throw new Error(`page delete aborted — redirect ${oldPath} → ${input.redirectTo} failed`);
    }
  }
  return ok({});
}

export const deletePageOp = defineOperation({
  name: "pages.delete",
  readScope: "request",
  // P6.7.5 — soft-delete. `disposition` decides what the dead URL does:
  // omitted (or '404') = the URL 404s; 'redirect' = a 301 from the old path to
  // `redirectTo`, created on THIS tx. The dead-URL side-effect lives in the op
  // (audit #4) so bulk delete (`pages.delete_many`, which loops this handler)
  // inherits it atomically — before, the 301 lived in the `delete_page` tool
  // and the bulk path silently produced none (every bulk-deleted page left a
  // dead URL with no redirect). `disposition` is optional because the human UI
  // + translation-variant deletes are plain soft-deletes; the AI-facing tool
  // requires it so the AI can never silently strand a dead URL.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: deletePageInputSchema,
  output: z.object({}),
  handler: (ctx, input, tx) => deletePageHandler(ctx, input, tx),
});

/** One placement of a page about to be duplicated, in render order. */
interface DuplicablePlacement {
  readonly blockName: string;
  readonly position: number;
  readonly moduleId: string;
  readonly contentInstanceId: string;
}

/**
 * The source page's placements as the CALLER sees them — the chat's
 * branch-overlaid layout when it reshaped the page, else live
 * `page_modules` — minus placements of modules that are deleted in that
 * view. `pages.set_modules` rejects deleted module ids at write time; the
 * copy keeps the same invariant instead of propagating dead references
 * (P6.7.7 audit). Positions are renumbered per block over the kept
 * placements, so the copy's (block, position) addresses stay dense the
 * way every placement reader indexes them.
 */
async function loadDuplicablePlacements(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  sourcePageId: string,
): Promise<
  { ok: true; kept: DuplicablePlacement[]; total: number } | { ok: false; message: string }
> {
  const layout = await loadPageLayoutStateWithBranchOverlay(
    tx,
    sourcePageId,
    ctx.chatBranchId ?? null,
  );
  const all: Omit<DuplicablePlacement, "position">[] = [];
  for (const block of layout.blocks) {
    if (block.placements === undefined) {
      // A pre-v0.12 layout snapshot names modules but not their content.
      return {
        ok: false,
        message: `the source page's layout for block "${block.blockName}" has no content bindings (pre-v0.12 snapshot); re-save the page's modules (pages.set_modules) before duplicating`,
      };
    }
    for (const p of block.placements) {
      all.push({
        blockName: block.blockName,
        moduleId: p.moduleId,
        contentInstanceId: p.contentInstanceId,
      });
    }
  }
  const moduleIds = [...new Set(all.map((p) => p.moduleId))];
  const live = new Set<string>();
  if (moduleIds.length > 0) {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id FROM modules
      WHERE id = ANY(${uuidArray(moduleIds)}) AND deleted_at IS NULL
    `)) as unknown as { id: string }[];
    for (const r of rows) live.add(r.id);
    if (ctx.chatBranchId) {
      // A module the chat deleted (or restored) counts as the chat sees it.
      const branched = await loadBranchedModuleStates(tx, ctx.chatBranchId, moduleIds);
      for (const [id, state] of branched) {
        if (state.deletedAt === null) live.add(id);
        else live.delete(id);
      }
    }
  }
  const nextPosition = new Map<string, number>();
  const kept: DuplicablePlacement[] = [];
  for (const p of all) {
    if (!live.has(p.moduleId)) continue;
    const position = nextPosition.get(p.blockName) ?? 0;
    nextPosition.set(p.blockName, position + 1);
    kept.push({ ...p, position });
  }
  return { ok: true, kept, total: all.length };
}

/**
 * P6.7.7 — clone an existing page (and its module layout) under a new
 * slug. Modules are referenced by id, not deep-copied: edits to a
 * shared module propagate to every page using it. Content is copied
 * (nested content included), so the copy's text diverges freely. The
 * page and its layout are read as the caller sees them (a chat's draft
 * edits included). The duplicated page
 * inherits the source page's templateId by default; callers that need
 * a different page-type pass `targetTemplateId` (validated like
 * pages.update).
 */
export const duplicatePageOp = defineOperation({
  name: "pages.duplicate",
  readScope: "request",
  // #396 — plugin actors duplicate too: international-site's
  // create_variant mints the counterpart page through this op (epic
  // #380 decision 3 — release-signed plugins hold cms_admin writes).
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      sourcePageId: z.string().uuid(),
      newSlug: slugSchema,
      newTitle: z.string().min(1).max(256).optional(),
      /** #1142 — omitted = `newTitle` when given, else the source's short title. */
      newShortTitle: pageShortTitleSchema.optional(),
      targetTemplateId: z.string().uuid().optional(),
      /**
       * #1276 — the copy's page type (slug). Omitted = the source's type
       * (or the one type listing `targetTemplateId` when the source's type
       * does not allow it), with the source's confirmed flag.
       */
      pageType: pageTypeSlugSchema.optional(),
      /**
       * 0264 — where the copy sits: a parent page id, or null for the
       * top level. Omitted = a sibling of the source (same parent).
       */
      newParentPageId: z.string().uuid().nullable().optional(),
    })
    .strict(),
  output: z.object({ pageId: z.string() }),
  handler: async (ctx, input, tx) => {
    const sourceRows = (await tx.execute(sql`
      SELECT id::text AS id, slug, title,
             template_id::text AS template_id
      FROM pages WHERE id = ${input.sourcePageId}::uuid AND deleted_at IS NULL
      ${branchVisibilityFilter(ctx)} LIMIT 1
    `)) as unknown as {
      id: string;
      slug: string;
      title: string;
      template_id: string;
    }[];
    const source = sourceRows[0];
    // The copy starts from the source as the caller sees it: a chat that
    // retitled, retyped or deleted the source on its branch copies that.
    const sourceState = source
      ? await loadPageStateWithBranchOverlay(tx, input.sourcePageId, ctx.chatBranchId)
      : null;
    if (!source || !sourceState || sourceState.deletedAt !== null) {
      return err({
        kind: "HandlerError",
        operation: "pages.duplicate",
        message: "source page not found",
      });
    }
    const targetTemplateId = input.targetTemplateId ?? sourceState.templateId;
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
    // 0263/0264 — the copy is a sibling of the source by default (same
    // parent in the caller's view, so `/docs/a` duplicates to `/docs/b`);
    // its URL must be free in that view.
    const dupTree = await loadPageTree(tx, ctx.chatBranchId ?? null);
    const dupParent =
      input.newParentPageId !== undefined
        ? input.newParentPageId
        : (dupTree.byId.get(input.sourcePageId)?.parentPageId ?? null);
    const dupTempId = crypto.randomUUID();
    const dupPlan = await planPageMoves(tx, renderScopeOf(ctx), [
      { pageId: dupTempId, isNew: true, parentPageId: dupParent, newSlug: input.newSlug },
    ]);
    if (!dupPlan.ok) {
      return err({ kind: "HandlerError", operation: "pages.duplicate", message: dupPlan.message });
    }
    const dupPath = dupPlan.plan.pathsAfter.get(dupTempId) ?? null;
    const title = input.newTitle ?? sourceState.title;
    // A new title without a new short title means a page about something
    // else: its crumb follows the new title, not the source's label.
    const shortTitle =
      input.newShortTitle ??
      (input.newTitle !== undefined ? input.newTitle : sourceState.shortTitle);
    // Epic #1107 — the copy is the same kind of page (type, properties,
    // terms as the caller sees the source); another template keeps the
    // type when the type allows it, else takes the one type listing it.
    const dupType = await nextTypeBound(
      tx,
      ctx,
      {
        pageId: input.sourcePageId,
        templateId: targetTemplateId,
        ...(input.pageType !== undefined ? { pageType: input.pageType } : {}),
      },
      sourceState,
    );
    if (!dupType.ok) {
      return err(
        handlerErrorFromDetails(
          "pages.duplicate",
          dupType.details.map((d) =>
            d.path[0] === "templateId"
              ? { ...d, path: ["targetTemplateId", ...d.path.slice(1)] }
              : d,
          ),
        ),
      );
    }
    // Branched like pages.create: a copy made in a chat is that chat's
    // page until publish, not a live draft other chats and the site see.
    const inserted = (await tx.execute(sql`
      INSERT INTO pages (slug, title, short_title, template_id, status, chat_branch_id, parent_page_id, current_path,
                         page_type_id, page_type_confirmed, properties)
      VALUES (
        ${input.newSlug}, ${title}, ${shortTitle},
        ${targetTemplateId}::uuid, 'draft',
        ${ctx.chatBranchId ?? null}::uuid,
        ${dupParent}::uuid,
        ${dupPath},
        ${dupType.pageTypeId}::uuid,
        ${dupType.pageTypeConfirmed},
        ${jsonbParam(dupType.properties)}
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const newPageId = inserted[0]?.id;
    if (!newPageId) {
      return err(internalError("pages.duplicate", "the page copy insert returned no id"));
    }
    await replacePageTerms(tx, newPageId, dupType.terms);
    // Modules carry over by reference — same module ids, same block
    // names, same order. If the target template has different block
    // names, the migration is the caller's responsibility (use
    // change_template afterward).
    const placements = await loadDuplicablePlacements(tx, ctx, input.sourcePageId);
    if (!placements.ok) {
      return err({
        kind: "HandlerError",
        operation: "pages.duplicate",
        message: placements.message,
      });
    }
    const totalSource = placements.total;
    const liveSource = placements.kept.length;
    // v0.12.0 — duplicate clones the source's content too, not just
    // rebinds to it: each placement gets a fresh unsynced instance so the
    // copy diverges without touching the source (shared-synced semantics
    // are available via set_placement_content afterwards). The copy is
    // deep: content nested in module / module-list fields gets its own
    // rows as well, else the copy's nested sections would still be the
    // source's. Copies come back in placement order, so each placement
    // binds to the copy of exactly its own content.
    const clones = await cloneContentInstancesDeep(
      tx,
      ctx,
      placements.kept.map((p) => p.contentInstanceId),
    );
    if (!clones.ok) {
      return err({ kind: "HandlerError", operation: "pages.duplicate", message: clones.message });
    }
    if (placements.kept.length > 0) {
      const rows = placements.kept.map(
        (p, i) => sql`(
          ${newPageId}::uuid, ${p.blockName}, ${p.position}, ${p.moduleId}::uuid,
          ${clones.ids[i]}::uuid, 'unsynced'
        )`,
      );
      await tx.execute(sql`
        INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        VALUES ${sql.join(rows, sql`, `)}
      `);
    }
    // P7 review-pass: bump media usage_count for every distinct asset
    // referenced from the cloned modules' HTML. A duplicated page adds
    // a fresh set of live references, so find_media's `most_used` sort
    // surfaces the asset as more popular. Same diff helper that
    // modules.update calls; HTML is unchanged so we treat the empty
    // string as "before" and the union of all module HTML as "after".
    const clonedModules = (await tx.execute(sql`
      SELECT m.html FROM page_modules pm
      JOIN modules m ON m.id = pm.module_id AND m.deleted_at IS NULL
      WHERE pm.page_id = ${newPageId}::uuid
    `)) as unknown as { html: string }[];
    if (clonedModules.length > 0) {
      // `extractMediaRefs` yields slug refs (current embeds) + legacy UUID
      // id refs; resolve the slugs to ids (one batched query) so the
      // usage bump below operates purely on asset ids.
      const ids = new Set<string>();
      const slugs = new Set<string>();
      for (const r of clonedModules) {
        for (const ref of extractMediaRefs(r.html)) {
          if (ref.isSlug) slugs.add(ref.ref);
          else ids.add(ref.ref);
        }
      }
      if (slugs.size > 0) {
        const slugRows = (await tx.execute(sql`
          SELECT id::text AS id FROM media_assets
          WHERE slug = ANY(${textArray([...slugs])}) AND deleted_at IS NULL
        `)) as unknown as { id: string }[];
        for (const row of slugRows) ids.add(row.id);
      }
      for (const assetId of ids) {
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
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "page", entityId: newPageId, state }],
      });
    }
    await recomputeCurrentPaths(tx, [newPageId], renderScopeOf(ctx));
    const layoutState = await loadPageLayoutState(tx, newPageId);
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "pages.set_modules",
      description: `pages.duplicate layout from=${source.slug}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: ctx.chatBranchId ?? null,
      // The copied content rides with the layout that binds it — nested
      // copies too, so an undo or revert of the duplicate reaches every
      // row it minted (#1126).
      entities: [
        { kind: "pageLayout", entityId: newPageId, state: layoutState },
        ...clones.snapshotEntities,
      ],
    });
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
  readScope: "request",
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
    // Epic #1107 — the page keeps its type when the type allows the new
    // template; otherwise it takes the one type that lists it, and must
    // fit that type.
    const liveState = await loadPageState(tx, input.pageId);
    if (!liveState) {
      return err({
        kind: "HandlerError",
        operation: "pages.change_template",
        message: "page not found",
      });
    }
    const typeBound = await nextTypeBound(
      tx,
      { ...ctx, chatBranchId: undefined },
      { pageId: input.pageId, templateId: input.newTemplateId },
      liveState,
    );
    if (!typeBound.ok) {
      return err(
        handlerErrorFromDetails(
          "pages.change_template",
          typeBound.details.map((d) =>
            d.path[0] === "templateId" ? { ...d, path: ["newTemplateId", ...d.path.slice(1)] } : d,
          ),
          {
            trailer:
              "To move the page to another page type together with the template, use pages.update with pageType and templateId.",
          },
        ),
      );
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
          page_type_id = ${typeBound.pageTypeId}::uuid,
          page_type_confirmed = ${typeBound.pageTypeConfirmed},
          properties = ${jsonbParam(typeBound.properties)},
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
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  // audit #4 — per-item `disposition` so a bulk delete carries the SAME
  // dead-URL semantics as a single delete: each page can 404 or 301 to its own
  // target, all on one tx. (Was a flat `pageIds` list with no disposition, so
  // every bulk-deleted page silently 404'd.)
  input: z
    .object({
      deletions: z
        .array(
          z
            .object({
              pageId: z.string().uuid(),
              disposition: z.enum(["404", "redirect"]).optional(),
              redirectTo: redirectTargetPathSchema.optional(),
              children: pageDeleteChildrenSchema.optional(),
            })
            .refine((v) => v.disposition !== "redirect" || !!v.redirectTo, {
              message: "disposition 'redirect' requires redirectTo",
            }),
        )
        .min(1)
        .max(200),
    })
    .strict(),
  output: z.object({
    deleted: z.number().int(),
    alreadyDeleted: z.number().int(),
    notFound: z.number().int(),
    /** Pages not deleted, with the reason + next step (e.g. it has
     *  child pages and no `children` decision was given). */
    refused: z.array(z.object({ pageId: z.string(), reason: z.string() })),
  }),
  handler: async (ctx, input, tx) => {
    // v0.5.7 — delegate to deletePageOp per row so bulk delete picks up
    // the v0.5.3 branched-delete + per-page-lock behaviour automatically,
    // and (audit #4) the per-page redirect disposition too.
    // Pre-loop check for "not found" / "already deleted" so the result
    // shape stays the same (deleted / alreadyDeleted / notFound counts).
    let deleted = 0;
    let alreadyDeleted = 0;
    let notFound = 0;
    const refused: { pageId: string; reason: string }[] = [];
    // 0263 — deepest pages first, so a batch that deletes a page AND all
    // its children needs no `children` decision: by the time the parent
    // comes up, its children are gone.
    const tree = await loadPageTree(tx, ctx.chatBranchId ?? null);
    const depthOf = (id: string): number =>
      tree.byId.has(id) ? ancestorIdsOf(tree, id).length : 0;
    const ordered = [...input.deletions].sort((a, b) => depthOf(b.pageId) - depthOf(a.pageId));
    for (const item of ordered) {
      const id = item.pageId;
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
      const r = await deletePageOp.handler(
        ctx,
        {
          pageId: id,
          disposition: item.disposition,
          redirectTo: item.redirectTo,
          ...(item.children ? { children: item.children } : {}),
        },
        tx,
      );
      if (r.ok) deleted += 1;
      else
        refused.push({ pageId: id, reason: "message" in r.error ? r.error.message : r.error.kind });
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
      resultSummary: `deleted=${deleted},alreadyDeleted=${alreadyDeleted},notFound=${notFound},refused=${refused.length}`,
    });
    return ok({ deleted, alreadyDeleted, notFound, refused });
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
  readScope: "request",
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
    /** Why each refused update was refused — the message names the fix
     *  (e.g. a URL conflict the rename would cause). */
    failures: z.array(z.object({ pageId: z.string(), reason: z.string() })),
  }),
  handler: async (ctx, input, tx) => {
    let updated = 0;
    let notFound = 0;
    const conflicts: string[] = [];
    const failures: { pageId: string; reason: string }[] = [];
    for (const upd of input.updates) {
      const r = await updatePageOp.handler(ctx, upd, tx);
      if (!r.ok) {
        const msg = (r.error as { message?: string }).message ?? "";
        failures.push({ pageId: upd.pageId, reason: msg || r.error.kind });
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
    return ok({ updated, notFound, conflicts, failures });
  },
});
