// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1212 — the page-specific reads of `pages.render_preview`, in one
 * short transaction: the page with its template and layout, its placed
 * modules and their content, the layout's chrome modules, the modules and
 * instances nested inside them, the active theme, the page URL style and
 * the page's SEO. Each overlaid with the caller's branch as before (P6.7,
 * v0.5.x, v0.9.0, v0.12.x, run #8 — the reasons are kept at each step).
 *
 * Everything that grows with the SITE (pages, lists, media, SEO
 * summaries) is the site view's (`site-view.ts`); what is here grows only
 * with the page. Nothing here calls a plugin: the caller holds this
 * transaction only for these reads.
 */

import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import {
  buildMediaUrl,
  type ComposeTheme,
  collectNestedRefs,
  type NestedContentInstanceResource,
  type NestedModuleResource,
  type PageUrlStyle,
  type TemplateField,
  templateFieldsFromJson,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../../draft.js";
import { pageSeoViewSql } from "../../seo/page-seo.js";
import { effectiveLayoutModulesSql } from "./layout-overlay.js";
import { loadActiveThemeForCompose } from "./preview-theme.js";
import { loadPublishPageUrlStyle } from "./public-urls.js";

/** A placed (or chrome) module as the preview renders it. */
export interface ModuleSourceRow {
  block_name: string;
  position: number;
  module_id: string;
  slug: string;
  display_name: string;
  html: string;
  css: string;
  js: string;
  /** v0.4.0 — module field schema (drives placeholder substitution). */
  fields: unknown;
}

/** The page row joined with its template and layout. */
export interface PreviewPageRow {
  page_id: string;
  slug: string;
  current_path: string;
  title: string;
  template_html: string;
  template_css: string;
  layout_id: string;
  layout_slug: string;
  layout_html: string;
  layout_css: string;
}

/** `${block_name}#${position}` → the placement's content binding. */
export type PlacementBindings = Map<string, { contentInstanceId: string; synced: boolean }>;

/** The modules and content instances the recursive renderer resolves. */
export interface NestedResources {
  readonly modules: Map<string, NestedModuleResource>;
  readonly instances: Map<string, NestedContentInstanceResource>;
}

/** Everything page-specific a preview render reads. */
export interface PreviewPageBundle {
  readonly pageRow: PreviewPageRow;
  readonly modRows: ModuleSourceRow[];
  readonly layoutModRows: ModuleSourceRow[];
  readonly placementBindings: PlacementBindings;
  readonly valuesByInstance: Map<string, Record<string, unknown>>;
  readonly resources: NestedResources;
  readonly theme: ComposeTheme | undefined;
  readonly pageUrlStyle: PageUrlStyle;
  readonly seo: {
    readonly metaDescription: string;
    readonly canonicalUrl: string | null;
    readonly noindex: boolean;
  } | null;
  readonly ogImageUrl: string | null;
  /** #918 — pages showing each synced instance (only with edit markers). */
  readonly sharedPageCounts: Map<string, number>;
}

/** Why the page cannot render; the op returns it as its error message. */
export class PreviewLoadError extends Error {
  override readonly name = "PreviewLoadError";
}

/**
 * The module's field schema as the template engine renders it. jsonb may
 * carry a typo'd or unknown kind; it passes through so the engine emits
 * kind-mismatch loudly (compile-time safety lives at the authoring tools).
 */
export function parseFields(raw: unknown): TemplateField[] {
  return templateFieldsFromJson(raw);
}

/**
 * Read the page bundle. Throws {@link PreviewLoadError} for a page that
 * does not exist in the caller's view ("page not found"), a layout
 * without a `content` block, or a missing default deploy target.
 */
export async function loadPreviewPage(
  tx: TransactionRunner,
  input: {
    readonly pageId: string;
    readonly chatBranchId: string | null;
    readonly editMarkers: boolean;
  },
): Promise<PreviewPageBundle> {
  const { pageId, chatBranchId } = input;
  // v0.9.0 — branch-aware preview. The iframe shows the caller's
  // branched-create pages / templates / layouts (in addition to main).
  // Without this filter, a brand-new chat that just created its first
  // page+template+layout would fail to render because the JOIN'd live
  // rows are branched to the chat.
  const branchScope = chatBranchId
    ? sql`AND (p.chat_branch_id IS NULL OR p.chat_branch_id = ${chatBranchId}::uuid)
          AND (t.chat_branch_id IS NULL OR t.chat_branch_id = ${chatBranchId}::uuid)
          AND (l.chat_branch_id IS NULL OR l.chat_branch_id = ${chatBranchId}::uuid)`
    : sql`AND p.chat_branch_id IS NULL AND t.chat_branch_id IS NULL AND l.chat_branch_id IS NULL`;
  const pageRows = (await tx.execute(sql`
    SELECT p.id::text AS page_id, p.slug AS slug, p.current_path, p.title AS title,
           t.html AS template_html, t.css AS template_css,
           l.id::text AS layout_id, l.slug AS layout_slug,
           l.html AS layout_html, l.css AS layout_css
    FROM pages p
    JOIN templates t ON t.id = p.template_id
    JOIN layouts l   ON l.id = t.layout_id
    WHERE p.id = ${pageId}::uuid AND p.deleted_at IS NULL ${branchScope}
    LIMIT 1
  `)) as unknown as PreviewPageRow[];
  const pageRow = pageRows[0];
  if (!pageRow) throw new PreviewLoadError("page not found");

  // v0.5.5 — page meta overlay: a branched pages.update writes slug/title
  // into page_snapshots while the live join above still carries the
  // pre-branch values. Overlay slug + title only — a templateId overlay
  // (which would cascade through template / layout) is out of scope until
  // pages.change_template branches.
  if (chatBranchId) {
    const snap = (await tx.execute(sql`
      SELECT state FROM page_snapshots ps
      JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
      WHERE ps.page_id = ${pageId}::uuid
        AND ss.chat_branch_id = ${chatBranchId}::uuid AND ${pendingSnapshotSql()}
      ORDER BY ss.created_at DESC LIMIT 1
    `)) as unknown as { state: unknown }[];
    if (snap[0]?.state) {
      const s = snap[0].state as { slug?: string; title?: string };
      if (s.slug) pageRow.slug = s.slug;
      if (s.title) pageRow.title = s.title;
    }
  }
  // P6.7.6 no-fallbacks invariant — the layout must declare a `content`
  // block (the slot the template renders into): loud instead of chrome
  // with no body.
  const layoutBlocks = (await tx.execute(sql`
    SELECT name FROM layout_blocks WHERE layout_id = ${pageRow.layout_id}::uuid
  `)) as unknown as { name: string }[];
  if (!layoutBlocks.some((r) => r.name === "content")) {
    throw new PreviewLoadError(
      `layout "${pageRow.layout_slug}" is missing the required \`content\` block — fix via /settings/layouts`,
    );
  }

  // The live placements: their modules (deleted modules render nothing)
  // and their content bindings, one read.
  const placed = (await tx.execute(sql`
    SELECT pm.block_name AS block_name, pm.position AS position,
           pm.content_instance_id::text AS content_instance_id, pm.sync_mode AS sync_mode,
           m.id::text AS module_id, m.slug AS slug, m.display_name AS display_name,
           m.html AS html, m.css AS css, m.js AS js, m.fields AS fields
    FROM page_modules pm LEFT JOIN modules m ON m.id = pm.module_id AND m.deleted_at IS NULL
    WHERE pm.page_id = ${pageId}::uuid
    ORDER BY pm.block_name ASC, pm.position ASC
  `)) as unknown as (Omit<ModuleSourceRow, "module_id"> & {
    module_id: string | null;
    content_instance_id: string;
    sync_mode: string;
  })[];
  let modRows: ModuleSourceRow[] = placed
    .filter((r): r is typeof r & { module_id: string } => r.module_id !== null)
    .map((r) => ({
      block_name: r.block_name,
      position: r.position,
      module_id: r.module_id,
      slug: r.slug,
      display_name: r.display_name,
      html: r.html,
      css: r.css,
      js: r.js,
      fields: r.fields,
    }));
  // v0.12.0 — module CONTENT lives in content_instances, keyed by the
  // placement's instance id (re-using an instance across pages and forking
  // diverging copies both compose correctly).
  const placementBindings: PlacementBindings = new Map();
  for (const r of placed) {
    placementBindings.set(`${r.block_name}#${r.position}`, {
      contentInstanceId: r.content_instance_id,
      synced: r.sync_mode === "synced",
    });
  }

  if (chatBranchId) {
    // v0.5.3 — the chat's branched page_layout_snapshot replaces the live
    // page_modules ordering (blocks/moduleIds) AND the live bindings
    // (placement.set_content / fork_placement_content). Read once for both.
    const layoutSnap = (await tx.execute(sql`
      SELECT state FROM page_layout_snapshots pls
      JOIN site_snapshots ss ON ss.id = pls.site_snapshot_id
      WHERE pls.page_id = ${pageId}::uuid
        AND ss.chat_branch_id = ${chatBranchId}::uuid AND ${pendingSnapshotSql()}
      ORDER BY ss.created_at DESC
      LIMIT 1
    `)) as unknown as { state: unknown }[];
    if (layoutSnap[0]?.state) {
      const parsed = layoutSnap[0].state as {
        blocks?: {
          blockName: string;
          moduleIds: string[];
          placements?: { moduleId: string; contentInstanceId: string; syncMode: string }[];
        }[];
      };
      if (Array.isArray(parsed.blocks)) {
        modRows = await branchPlacedModules(tx, parsed.blocks, chatBranchId);
      }
      if (parsed.blocks) {
        placementBindings.clear();
        for (const b of parsed.blocks) {
          const placements = b.placements ?? [];
          for (let i = 0; i < placements.length; i += 1) {
            const p = placements[i];
            if (p) {
              placementBindings.set(`${b.blockName}#${i}`, {
                contentInstanceId: p.contentInstanceId,
                synced: p.syncMode === "synced",
              });
            }
          }
        }
      }
    }
  }

  await overlayPlacedModuleCode(tx, modRows, chatBranchId);

  const allInstanceIds = [
    ...new Set([...placementBindings.values()].map((b) => b.contentInstanceId)),
  ];
  const valuesByInstance = new Map<string, Record<string, unknown>>();
  const instanceModuleIdById = new Map<string, string>();
  if (allInstanceIds.length > 0) {
    const valueRows = (await tx.execute(sql`
      SELECT id::text AS id, module_id::text AS module_id, "values" AS values
      FROM content_instances
      WHERE id = ANY(${uuidArray(allInstanceIds)}) AND deleted_at IS NULL
    `)) as unknown as { id: string; module_id: string; values: unknown }[];
    for (const r of valueRows) {
      valuesByInstance.set(r.id, (r.values ?? {}) as Record<string, unknown>);
      instanceModuleIdById.set(r.id, r.module_id);
    }
    // Branch overlay — content_instance_snapshots tagged with this chat's
    // branch supersede live values for the same instance.
    if (chatBranchId) {
      for (const [id, values] of await branchInstanceValues(tx, allInstanceIds, chatBranchId)) {
        valuesByInstance.set(id, values);
      }
    }
  }

  const resources: NestedResources = { modules: new Map(), instances: new Map() };
  for (const m of modRows) {
    resources.modules.set(m.module_id, {
      moduleId: m.module_id,
      slug: m.slug,
      html: m.html,
      css: m.css,
      js: m.js,
      fields: parseFields(m.fields),
    });
  }
  for (const [id, values] of valuesByInstance) {
    const moduleId = instanceModuleIdById.get(id) ?? "";
    resources.instances.set(id, { id, moduleId, values, deletedAt: null });
  }

  // P6.7.6 — the layout's chrome modules (every block but `content`).
  // issue #106 — with their `fields`: chrome has no content binding, its
  // content is the field defaults, which the composer renders only when
  // it gets the fields (raw `{{nav_links}}` shipped to the preview before).
  const layoutModRows = (await tx.execute(sql`
    SELECT lm.block_name AS block_name,
           lm.position   AS position,
           m.id::text    AS module_id,
           m.slug        AS slug,
           m.display_name AS display_name,
           m.html        AS html,
           m.css         AS css,
           m.js          AS js,
           m.fields      AS fields
    FROM (${effectiveLayoutModulesSql(chatBranchId ?? undefined)}) lm JOIN modules m ON m.id = lm.module_id
    WHERE lm.layout_id = ${pageRow.layout_id}::uuid AND m.deleted_at IS NULL
    ORDER BY lm.block_name ASC, lm.position ASC
  `)) as unknown as ModuleSourceRow[];
  // Caller-branch module-code overlay for chrome — the run-#8-R3 class: a
  // branched footer edit writes module_snapshots only, and without this the
  // preview kept the stale chrome and the AI re-edited in a loop. Fields
  // ride along: chrome renders from field DEFAULTS.
  if (chatBranchId && layoutModRows.length > 0) {
    const overlay = await branchModuleStates(
      tx,
      layoutModRows.map((r) => r.module_id),
      chatBranchId,
    );
    for (const m of layoutModRows) {
      const s = overlay.get(m.module_id);
      if (!s || s.deletedAt) continue;
      m.html = (s.html as string) ?? m.html;
      m.css = (s.css as string) ?? m.css;
      m.js = (s.js as string) ?? m.js;
      m.display_name = (s.displayName as string) ?? m.display_name;
      if (Array.isArray(s.fields)) m.fields = s.fields as ModuleSourceRow["fields"];
    }
  }

  // v0.12.1 — modules and instances nested in the placed content and in
  // chrome field defaults, loaded before rendering so the renderer never
  // blocks on I/O. (Modules embedded in shared list entries are added by
  // the caller once the list data is known: `expandNestedResources`.)
  const seeds: Record<string, unknown>[] = [...resources.instances.values()].map((r) => r.values);
  for (const m of layoutModRows) {
    const defaults: Record<string, unknown> = {};
    for (const f of parseFields(m.fields)) {
      if (f.default !== undefined) defaults[f.name] = f.default;
    }
    seeds.push(defaults);
  }
  await expandNestedResources(tx, resources, seeds, chatBranchId);

  // v0.11.1 (issue #76) — the active theme: asset URLs for nested-module
  // `{{theme_logo_url}}` and the composer's theme <style>.
  const theme = await loadActiveThemeForCompose(tx, chatBranchId ?? undefined);
  // #590 — every URL the preview shows follows the publish target's style.
  const pageUrlStyle = await loadPublishPageUrlStyle(tx);
  if (pageUrlStyle === null) {
    throw new PreviewLoadError(
      "no default deploy target — the preview needs its page URL style to render canonical " +
        "and language links. Next step: run the cms_admin migrations (they seed the " +
        "production target) or mark a deploy target as default under Ops → Deploy.",
    );
  }

  // #918 — how many pages show each synced instance, so the editor can say
  // "this text is on N pages" before an in-place edit.
  const sharedPageCounts = new Map<string, number>();
  const syncedIds = [...placementBindings.values()]
    .filter((b) => b.synced && !b.contentInstanceId.startsWith("variant:"))
    .map((b) => b.contentInstanceId);
  if (input.editMarkers && syncedIds.length > 0) {
    const counts = (await tx.execute(sql`
      SELECT content_instance_id::text AS id, count(DISTINCT page_id)::int AS pages
      FROM page_modules
      WHERE content_instance_id = ANY(${uuidArray([...new Set(syncedIds)])})
      GROUP BY content_instance_id
    `)) as unknown as { id: string; pages: number }[];
    for (const r of counts) sharedPageCounts.set(r.id, Number(r.pages));
  }

  // #1156 — the SEO this render's branch shows (a chat's pending edit).
  const seoRows = (await tx.execute(sql`
    SELECT s.meta_description, s.og_image_asset_id::text AS og_image_asset_id,
           s.canonical_url, s.noindex
    FROM ${pageSeoViewSql(chatBranchId ?? undefined, [pageId])} s LIMIT 1
  `)) as unknown as {
    meta_description: string;
    og_image_asset_id: string | null;
    canonical_url: string | null;
    noindex: boolean;
  }[];
  const seoRow = seoRows[0];
  let ogImageUrl: string | null = null;
  if (seoRow?.og_image_asset_id) {
    const variants = (await tx.execute(sql`
      SELECT mv.variant AS variant, mv.format AS format, ma.slug AS slug
      FROM media_variants mv
      JOIN media_assets ma ON ma.id = mv.asset_id AND ma.deleted_at IS NULL
      WHERE mv.asset_id = ${seoRow.og_image_asset_id}::uuid
      ORDER BY
        CASE mv.variant
          WHEN 'webp-1200' THEN 0 WHEN 'webp-1600' THEN 1
          WHEN 'webp-800'  THEN 2 WHEN 'orig'      THEN 3 ELSE 4
        END
      LIMIT 1
    `)) as unknown as { variant: string; format: string; slug: string }[];
    const v = variants[0];
    // Preview keeps the /_caelo/media URL form (built from the slug) so the
    // admin resolver serves the bytes; the static generator rewrites to
    // /_assets at deploy.
    if (v) ogImageUrl = buildMediaUrl(v.slug, v.variant);
  }

  return {
    pageRow,
    modRows,
    layoutModRows,
    placementBindings,
    valuesByInstance,
    resources,
    theme,
    pageUrlStyle,
    seo: seoRow
      ? {
          metaDescription: seoRow.meta_description,
          canonicalUrl: seoRow.canonical_url,
          noindex: seoRow.noindex,
        }
      : null,
    ogImageUrl,
    sharedPageCounts,
  };
}

/** The placed modules a branch's page layout snapshot names, in its order. */
async function branchPlacedModules(
  tx: TransactionRunner,
  blocks: readonly { blockName: string; moduleIds: string[] }[],
  chatBranchId: string,
): Promise<ModuleSourceRow[]> {
  const moduleIds = [...new Set(blocks.flatMap((b) => b.moduleIds))];
  if (moduleIds.length === 0) return [];
  // v0.9.0 — branch-aware module fetch so the chat sees its own
  // branched-create modules.
  const fetched = (await tx.execute(sql`
    SELECT m.id::text AS module_id, m.slug AS slug, m.display_name AS display_name,
           m.html AS html, m.css AS css, m.js AS js, m.fields AS fields
    FROM modules m
    WHERE m.id = ANY(${uuidArray(moduleIds)}) AND m.deleted_at IS NULL
      AND (m.chat_branch_id IS NULL OR m.chat_branch_id = ${chatBranchId}::uuid)
  `)) as unknown as Omit<ModuleSourceRow, "block_name" | "position">[];
  const byId = new Map(fetched.map((m) => [m.module_id, m]));
  const replaced: ModuleSourceRow[] = [];
  for (const b of blocks) {
    let pos = 0;
    for (const mid of b.moduleIds) {
      const m = byId.get(mid);
      if (!m) continue;
      replaced.push({ ...m, block_name: b.blockName, position: pos });
      pos += 1;
    }
  }
  return replaced;
}

/**
 * v0.5.1 — module code overlay on the placed modules: staged snapshots of
 * any branch, then the caller's branch (which wins ties: it sees its own
 * pending edits plus everyone's staged work, not other chats' pendings).
 */
async function overlayPlacedModuleCode(
  tx: TransactionRunner,
  modRows: ModuleSourceRow[],
  chatBranchId: string | null,
): Promise<void> {
  if (modRows.length === 0) return;
  const ids = modRows.map((r) => r.module_id);
  // Staged overlay — latest snapshot per module from any branch marked
  // staged, EXCLUDING the caller's own (applied below).
  const stagedRows = (await tx.execute(sql`
    SELECT DISTINCT ON (ms.module_id) ms.module_id::text AS module_id, ms.state
    FROM module_snapshots ms
    JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
    JOIN chat_branch_publish_marks m
      ON m.chat_branch_id = ss.chat_branch_id
     AND m.entity_kind = 'module'
     AND m.entity_id = ms.module_id
     AND m.stage_state = 'staged'
    WHERE ms.module_id = ANY(${uuidArray(ids)})
      ${chatBranchId ? sql`AND ss.chat_branch_id <> ${chatBranchId}::uuid` : sql``}
    ORDER BY ms.module_id, ss.created_at DESC
  `)) as unknown as { module_id: string; state: unknown }[];
  const overlay = new Map<string, Record<string, unknown>>();
  for (const r of stagedRows) overlay.set(r.module_id, r.state as Record<string, unknown>);
  if (chatBranchId) {
    for (const [id, s] of await branchModuleStates(tx, ids, chatBranchId)) overlay.set(id, s);
  }
  for (const m of modRows) {
    const s = overlay.get(m.module_id) as
      | {
          html?: string;
          css?: string;
          js?: string;
          displayName?: string;
          slug?: string;
          fields?: unknown;
          deletedAt?: string | null;
        }
      | undefined;
    // Soft-deleted in the overlay — keep live.
    if (!s || s.deletedAt) continue;
    m.html = s.html ?? "";
    m.css = s.css ?? "";
    m.js = s.js ?? "";
    m.display_name = s.displayName ?? "";
    m.slug = s.slug ?? "";
    // A branch update can ADD/RENAME fields (a new list field): carry the
    // branch schema, or a `{{#field}}` section over it renders literally.
    // A snapshot without fields keeps the live value.
    if (Array.isArray(s.fields)) m.fields = s.fields as ModuleSourceRow["fields"];
  }
}

/** The newest pending module state per module on the branch. */
async function branchModuleStates(
  tx: TransactionRunner,
  moduleIds: readonly string[],
  chatBranchId: string,
): Promise<Map<string, Record<string, unknown>>> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ON (ms.module_id) ms.module_id::text AS module_id, ms.state
    FROM module_snapshots ms
    JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
    WHERE ss.chat_branch_id = ${chatBranchId}::uuid AND ${pendingSnapshotSql()}
      AND ms.module_id = ANY(${uuidArray(moduleIds)})
    ORDER BY ms.module_id, ss.created_at DESC
  `)) as unknown as { module_id: string; state: unknown }[];
  return new Map(rows.map((r) => [r.module_id, r.state as Record<string, unknown>]));
}

/** The branch's pending values per instance (deleted ones left out). */
async function branchInstanceValues(
  tx: TransactionRunner,
  instanceIds: readonly string[],
  chatBranchId: string,
): Promise<Map<string, Record<string, unknown>>> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ON (cis.content_instance_id)
           cis.content_instance_id::text AS id, cis.state AS state
    FROM content_instance_snapshots cis
    JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id
    WHERE ss.chat_branch_id = ${chatBranchId}::uuid AND ${pendingSnapshotSql()}
      AND cis.content_instance_id = ANY(${uuidArray(instanceIds)})
    ORDER BY cis.content_instance_id, ss.created_at DESC
  `)) as unknown as { id: string; state: unknown }[];
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const state = (r.state ?? {}) as {
      values?: Record<string, unknown>;
      deletedAt?: string | null;
    };
    if (!state.deletedAt && state.values) out.set(r.id, state.values);
  }
  return out;
}

/** Whether `seeds` reference a module or instance `resources` lacks. */
export function hasUnloadedRefs(
  resources: NestedResources,
  seeds: readonly Record<string, unknown>[],
): boolean {
  return seeds.some((values) =>
    collectNestedRefs(values).some(
      (ref) =>
        !resources.modules.has(ref.moduleId) || !resources.instances.has(ref.contentInstanceId),
    ),
  );
}

/**
 * BFS-load the (moduleId, contentInstanceId) pairs `seeds` reference,
 * transitively, into `resources`, each with the caller's branch overlay
 * (the third and fourth read paths of the run-#8-R3 class: without them
 * the recursion rendered stale nested code / values and the AI spiralled
 * on "my edits don't propagate"). Bounded at 8 rounds: the renderer
 * enforces depth at substitute time and 8 levels is its maximum.
 */
export async function expandNestedResources(
  tx: TransactionRunner,
  resources: NestedResources,
  seeds: readonly Record<string, unknown>[],
  chatBranchId: string | null,
): Promise<void> {
  let pendingModuleIds = new Set<string>();
  let pendingInstanceIds = new Set<string>();
  const enqueueRefs = (values: Record<string, unknown>) => {
    for (const ref of collectNestedRefs(values)) {
      if (!resources.modules.has(ref.moduleId)) pendingModuleIds.add(ref.moduleId);
      if (!resources.instances.has(ref.contentInstanceId))
        pendingInstanceIds.add(ref.contentInstanceId);
    }
  };
  for (const v of seeds) enqueueRefs(v);

  for (let round = 0; round < 8; round += 1) {
    if (pendingModuleIds.size === 0 && pendingInstanceIds.size === 0) break;
    if (pendingModuleIds.size > 0) {
      const fetched = (await tx.execute(sql`
        SELECT id::text AS module_id, slug, display_name, html, css, js, fields
        FROM modules
        WHERE id = ANY(${uuidArray([...pendingModuleIds])}) AND deleted_at IS NULL
      `)) as unknown as ModuleSourceRow[];
      if (chatBranchId && fetched.length > 0) {
        const overlay = await branchModuleStates(
          tx,
          fetched.map((f) => f.module_id),
          chatBranchId,
        );
        for (const target of fetched) {
          const s = overlay.get(target.module_id);
          if (!s || s.deletedAt) continue;
          target.html = (s.html as string) ?? target.html;
          target.css = (s.css as string) ?? target.css;
          target.js = (s.js as string) ?? target.js;
          if (Array.isArray(s.fields)) target.fields = s.fields as ModuleSourceRow["fields"];
        }
      }
      for (const f of fetched) {
        resources.modules.set(f.module_id, {
          moduleId: f.module_id,
          slug: f.slug,
          html: f.html,
          css: f.css,
          js: f.js,
          fields: parseFields(f.fields),
        });
      }
      pendingModuleIds = new Set();
    }
    const justLoaded: Record<string, unknown>[] = [];
    if (pendingInstanceIds.size > 0) {
      const ids = [...pendingInstanceIds];
      const fetched = (await tx.execute(sql`
        SELECT id::text AS id, module_id::text AS module_id, "values" AS values
        FROM content_instances
        WHERE id = ANY(${uuidArray(ids)}) AND deleted_at IS NULL
      `)) as unknown as { id: string; module_id: string; values: unknown }[];
      const overlay =
        chatBranchId && fetched.length > 0
          ? await branchInstanceValues(
              tx,
              fetched.map((f) => f.id),
              chatBranchId,
            )
          : new Map<string, Record<string, unknown>>();
      for (const f of fetched) {
        const v = overlay.get(f.id) ?? ((f.values ?? {}) as Record<string, unknown>);
        resources.instances.set(f.id, {
          id: f.id,
          moduleId: f.module_id,
          values: v,
          deletedAt: null,
        });
        justLoaded.push(v);
      }
      pendingInstanceIds = new Set();
    }
    for (const v of justLoaded) enqueueRefs(v);
  }
}
