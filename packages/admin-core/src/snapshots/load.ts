// SPDX-License-Identifier: MPL-2.0

/**
 * Helpers that load the *current* state of a content entity for snapshot
 * emission. Called from inside a mutation op handler after the write so the
 * captured state matches what just landed on disk.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type {
  ContentInstanceState,
  ModuleState,
  PageLayoutState,
  PageState,
  TemplateState,
} from "./state.js";

function iso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export async function loadModuleState(
  tx: TransactionRunner,
  moduleId: string,
): Promise<ModuleState | null> {
  const rows = (await tx.execute(sql`
    SELECT slug, display_name, html, css, js, fields, deleted_at
    FROM modules WHERE id = ${moduleId}::uuid LIMIT 1
  `)) as unknown as {
    slug: string;
    display_name: string;
    html: string;
    css: string;
    js: string;
    fields: unknown;
    deleted_at: string | Date | null;
  }[];
  const r = rows[0];
  if (!r) return null;
  const rawFields = typeof r.fields === "string" ? JSON.parse(r.fields) : r.fields;
  return {
    schemaVersion: 1,
    slug: r.slug,
    displayName: r.display_name,
    html: r.html,
    css: r.css,
    js: r.js,
    fields: Array.isArray(rawFields) ? (rawFields as unknown[]) : [],
    deletedAt: iso(r.deleted_at),
  };
}

/**
 * v0.4.0 — Load page_module_content current state for snapshot emission.
 */
export async function loadPageModuleContentState(
  tx: TransactionRunner,
  pageModuleContentId: string,
): Promise<{
  schemaVersion: 1;
  pageId: string;
  blockName: string;
  position: number;
  contentValues: Record<string, unknown>;
  version: number;
} | null> {
  const rows = (await tx.execute(sql`
    SELECT page_id::text AS page_id, block_name, position, content_values, version
    FROM page_module_content
    WHERE id = ${pageModuleContentId}::uuid
    LIMIT 1
  `)) as unknown as {
    page_id: string;
    block_name: string;
    position: number;
    content_values: unknown;
    version: number | string;
  }[];
  const r = rows[0];
  if (!r) return null;
  const raw =
    typeof r.content_values === "string" ? JSON.parse(r.content_values) : r.content_values;
  return {
    schemaVersion: 1,
    pageId: r.page_id,
    blockName: r.block_name,
    position: r.position,
    contentValues: (raw ?? {}) as Record<string, unknown>,
    version: typeof r.version === "string" ? Number.parseInt(r.version, 10) : r.version,
  };
}

export async function loadTemplateState(
  tx: TransactionRunner,
  templateId: string,
): Promise<TemplateState | null> {
  const rows = (await tx.execute(sql`
    SELECT slug, display_name, html, css, deleted_at
    FROM templates WHERE id = ${templateId}::uuid LIMIT 1
  `)) as unknown as {
    slug: string;
    display_name: string;
    html: string;
    css: string;
    deleted_at: string | Date | null;
  }[];
  const r = rows[0];
  if (!r) return null;
  const blocks = (await tx.execute(sql`
    SELECT name, display_name, position FROM template_blocks
    WHERE template_id = ${templateId}::uuid
    ORDER BY position ASC
  `)) as unknown as { name: string; display_name: string; position: number }[];
  return {
    schemaVersion: 1,
    slug: r.slug,
    displayName: r.display_name,
    html: r.html,
    css: r.css,
    deletedAt: iso(r.deleted_at),
    blocks: blocks.map((b) => ({
      name: b.name,
      displayName: b.display_name,
      position: b.position,
    })),
  };
}

export async function loadPageState(
  tx: TransactionRunner,
  pageId: string,
): Promise<PageState | null> {
  const rows = (await tx.execute(sql`
    SELECT slug, locale, title, template_id, status, version, deleted_at
    FROM pages WHERE id = ${pageId}::uuid LIMIT 1
  `)) as unknown as {
    slug: string;
    locale: string;
    title: string;
    template_id: string;
    status: "draft" | "published";
    version: number | string;
    deleted_at: string | Date | null;
  }[];
  const r = rows[0];
  if (!r) return null;
  return {
    schemaVersion: 1,
    slug: r.slug,
    locale: r.locale,
    title: r.title,
    templateId: r.template_id,
    status: r.status,
    version: typeof r.version === "string" ? Number.parseInt(r.version, 10) : r.version,
    deletedAt: iso(r.deleted_at),
  };
}

/**
 * v0.10.0 — Branch-overlay variants of the live-state loaders.
 *
 * Branched-write op handlers (modules.update, pages.update, etc.) build
 * a new snapshot's `state` by combining "current entity state" with
 * "input patch". The pre-v0.10.0 implementation read "current state"
 * from the LIVE row — which works for the FIRST branched edit but
 * silently loses fields on chained ones:
 *
 *   1. Edit 1 (title='B'): live row has title='A'; snapshot 1 has
 *      state.title='B'. Live stays at 'A'.
 *   2. Edit 2 (slug='y'): live row still has title='A'; handler reads
 *      `existing.title='A'`; snapshot 2 has state.title='A',
 *      state.slug='y'. **Edit 1's 'B' is lost in snapshot 2.**
 *   3. Stage runs merge_to_main → applies the LATEST snapshot →
 *      live row.title='A'. The user's branched 'B' is gone.
 *
 * The overlay loaders fix this by preferring the LATEST branched
 * snapshot's `state` (when `chatBranchId` is set and at least one
 * branched snapshot for this entity+chat exists) over the live row.
 * Chained edits compose correctly: each new snapshot is built on top
 * of the previous branched snapshot, not the stale live row.
 *
 * When no branched snapshot exists for this entity in this chat (the
 * common N=1 case), fall through to the live-row loader — same
 * behavior as before v0.10.0.
 */
export async function loadModuleStateWithBranchOverlay(
  tx: TransactionRunner,
  moduleId: string,
  chatBranchId: string | null | undefined,
): Promise<ModuleState | null> {
  if (chatBranchId) {
    const rows = (await tx.execute(sql`
      SELECT ms.state
        FROM module_snapshots ms
        JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
       WHERE ms.module_id = ${moduleId}::uuid
         AND ss.chat_branch_id = ${chatBranchId}::uuid
       ORDER BY ss.created_at DESC
       LIMIT 1
    `)) as unknown as { state: unknown }[];
    const row = rows[0];
    if (row !== undefined) {
      const raw = typeof row.state === "string" ? JSON.parse(row.state) : row.state;
      return raw as ModuleState;
    }
  }
  return loadModuleState(tx, moduleId);
}

export async function loadPageStateWithBranchOverlay(
  tx: TransactionRunner,
  pageId: string,
  chatBranchId: string | null | undefined,
): Promise<PageState | null> {
  if (chatBranchId) {
    const rows = (await tx.execute(sql`
      SELECT ps.state
        FROM page_snapshots ps
        JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
       WHERE ps.page_id = ${pageId}::uuid
         AND ss.chat_branch_id = ${chatBranchId}::uuid
       ORDER BY ss.created_at DESC
       LIMIT 1
    `)) as unknown as { state: unknown }[];
    const row = rows[0];
    if (row !== undefined) {
      const raw = typeof row.state === "string" ? JSON.parse(row.state) : row.state;
      return raw as PageState;
    }
  }
  return loadPageState(tx, pageId);
}

/**
 * v0.10.13 — Branch-overlay variant of `loadPageLayoutState`. Returns
 * the LATEST `page_layout_snapshot` for this page on the caller's
 * chat branch if one exists, else falls through to the live
 * `page_modules` reader. Same shape as `loadPageLayoutState`.
 *
 * Why this exists: `pages.set_modules` in branched mode emits a
 * `page_layout_snapshot` and skips the live `page_modules` write. Any
 * subsequent read that doesn't union the snapshot sees STALE layout
 * — manifesting as "module X is not on page Y" when the AI chains
 * add_module_to_page → reorder_module on the same branched page.
 */
export async function loadPageLayoutStateWithBranchOverlay(
  tx: TransactionRunner,
  pageId: string,
  chatBranchId: string | null | undefined,
): Promise<PageLayoutState> {
  if (chatBranchId) {
    const rows = (await tx.execute(sql`
      SELECT pls.state
        FROM page_layout_snapshots pls
        JOIN site_snapshots ss ON ss.id = pls.site_snapshot_id
       WHERE pls.page_id = ${pageId}::uuid
         AND ss.chat_branch_id = ${chatBranchId}::uuid
       ORDER BY ss.created_at DESC
       LIMIT 1
    `)) as unknown as { state: unknown }[];
    const row = rows[0];
    if (row !== undefined) {
      const raw = typeof row.state === "string" ? JSON.parse(row.state) : row.state;
      return raw as PageLayoutState;
    }
  }
  return loadPageLayoutState(tx, pageId);
}

/**
 * v0.12.0 — Load content_instance current state for snapshot emission.
 * Mirrors `loadModuleState`'s shape; the branch-overlay variant below
 * fixes the chained-edit regression class for the new entity kind.
 */
export async function loadContentInstanceState(
  tx: TransactionRunner,
  contentInstanceId: string,
): Promise<ContentInstanceState | null> {
  const rows = (await tx.execute(sql`
    SELECT module_id::text AS module_id, slug, display_name, "values", version, deleted_at
    FROM content_instances
    WHERE id = ${contentInstanceId}::uuid
    LIMIT 1
  `)) as unknown as {
    module_id: string;
    slug: string | null;
    display_name: string | null;
    values: unknown;
    version: number | string;
    deleted_at: string | Date | null;
  }[];
  const r = rows[0];
  if (!r) return null;
  const rawValues = typeof r.values === "string" ? JSON.parse(r.values) : r.values;
  return {
    schemaVersion: 1,
    moduleId: r.module_id,
    slug: r.slug,
    displayName: r.display_name,
    values: (rawValues ?? {}) as Record<string, unknown>,
    version: typeof r.version === "string" ? Number.parseInt(r.version, 10) : r.version,
    deletedAt: iso(r.deleted_at),
  };
}

/**
 * v0.12.0 — Branch-overlay variant. Mirrors `loadModuleStateWithBranchOverlay`
 * so chained branched edits to the same content_instance don't silently drop
 * each other's values (the v0.10.0 regression class for `modules`, applied
 * here pre-emptively).
 */
export async function loadContentInstanceStateWithBranchOverlay(
  tx: TransactionRunner,
  contentInstanceId: string,
  chatBranchId: string | null | undefined,
): Promise<ContentInstanceState | null> {
  if (chatBranchId) {
    const rows = (await tx.execute(sql`
      SELECT cis.state
        FROM content_instance_snapshots cis
        JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id
       WHERE cis.content_instance_id = ${contentInstanceId}::uuid
         AND ss.chat_branch_id = ${chatBranchId}::uuid
       ORDER BY ss.created_at DESC
       LIMIT 1
    `)) as unknown as { state: unknown }[];
    const row = rows[0];
    if (row !== undefined) {
      const raw = typeof row.state === "string" ? JSON.parse(row.state) : row.state;
      return raw as ContentInstanceState;
    }
  }
  return loadContentInstanceState(tx, contentInstanceId);
}

export async function loadPageLayoutState(
  tx: TransactionRunner,
  pageId: string,
): Promise<PageLayoutState> {
  const rows = (await tx.execute(sql`
    SELECT block_name,
           position,
           module_id::text AS module_id,
           content_instance_id::text AS content_instance_id,
           sync_mode
    FROM page_modules WHERE page_id = ${pageId}::uuid
    ORDER BY block_name ASC, position ASC
  `)) as unknown as {
    block_name: string;
    position: number;
    module_id: string;
    content_instance_id: string;
    sync_mode: "synced" | "unsynced";
  }[];
  const grouped = new Map<
    string,
    {
      moduleIds: string[];
      placements: {
        moduleId: string;
        contentInstanceId: string;
        syncMode: "synced" | "unsynced";
      }[];
    }
  >();
  for (const r of rows) {
    const bucket = grouped.get(r.block_name) ?? { moduleIds: [], placements: [] };
    bucket.moduleIds.push(r.module_id);
    bucket.placements.push({
      moduleId: r.module_id,
      contentInstanceId: r.content_instance_id,
      syncMode: r.sync_mode,
    });
    grouped.set(r.block_name, bucket);
  }
  return {
    schemaVersion: 1,
    blocks: [...grouped.entries()].map(([blockName, b]) => ({
      blockName,
      moduleIds: b.moduleIds,
      placements: b.placements,
    })),
  };
}
