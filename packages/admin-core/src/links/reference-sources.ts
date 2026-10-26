// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout F) — everything the reference-integrity check reads:
 * every place a stored link can live, as one scope sees it.
 *
 * Places (CLAUDE.md §1A — the check names them in the operator's terms):
 *   - page placements: the module, its content instance's values, and the
 *     field defaults a value-less field renders;
 *   - nested modules (`module` / `module-list` values) below them;
 *   - layouts: their HTML and their chrome modules (whose content lives in
 *     the field defaults — layout placements have no content instance);
 *   - templates: their HTML;
 *   - lists (epic #1107): shared lists' entries, list types' source
 *     defaults, and pages' terms and properties — what `list` fields,
 *     queries and `{{page.*}}` render;
 *   - plugin storage, through the plugins' `linkLocationsOperation` hook
 *     (the same hook the link migration, rollout E, uses).
 *
 * Scope: `null` is the main line — what Stage merges onto and Publish live
 * ships. A chat branch is the draft as that chat's preview shows it: the
 * branch's created rows plus the latest pending snapshot of every entity
 * it edited (the same selection the Stage merge replays), so the AI can
 * verify a fix before it stages.
 *
 * Bounded: one query per entity kind (plus one overlay query per kind on a
 * branch), independent of the number of pages — the same shape as the
 * static build's loaders.
 */

import { collectPluginLinkLocations, MAIN_RENDER, withPluginScope } from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type ListItem,
  type ListTypeDef,
  MODULE_FIELD_KINDS,
  type ModuleFieldKind,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../draft.js";
import { loadPagesInView } from "../lists/pages-view.js";
import { loadListEntities } from "../lists/store.js";
import { effectiveLayoutModulesSql } from "../ops/content/layout-overlay.js";
import { parseSnapshotState } from "../snapshots/index.js";
import {
  parseAndUpgradeModuleState,
  parseAndUpgradePageLayoutState,
  parseAndUpgradeTemplateState,
} from "../snapshots/state-schemas.js";

/** A declared module field, as far as link scanning needs it. */
export interface SourceField {
  readonly name: string;
  readonly kind: ModuleFieldKind;
  readonly default?: unknown;
}

const FIELD_KINDS: ReadonlySet<string> = new Set(MODULE_FIELD_KINDS);

export interface SourceModule {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly html: string;
  readonly fields: readonly SourceField[];
}

export interface SourceInstance {
  readonly id: string;
  readonly moduleId: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface SourcePlacement {
  readonly pageId: string;
  readonly blockName: string;
  readonly moduleId: string;
  /** Null for a pre-v0.12 placement that renders its module's defaults. */
  readonly contentInstanceId: string | null;
  /**
   * `synced`: the placement shows the shared instance row, so a fix goes
   * to the instance (set_page_module_content_many refuses a synced placement).
   * Null when there is no instance.
   */
  readonly syncMode: "synced" | "unsynced" | null;
}

export interface SourceTemplate {
  readonly id: string;
  readonly name: string;
  readonly html: string;
  readonly layoutId: string | null;
}

export interface SourceLayout {
  readonly id: string;
  readonly name: string;
  readonly html: string;
  /** Chrome modules per block, in render order. */
  readonly blocks: readonly { readonly blockName: string; readonly moduleIds: readonly string[] }[];
}

/** One plugin-stored value that may carry links. */
export interface SourcePluginValue {
  readonly pluginSlug: string;
  /** Operator-facing ("German footer — layout main"), from the plugin. */
  readonly label: string;
  readonly value: unknown;
  /** Present when the value is a module content-values object. */
  readonly fields: readonly SourceField[] | null;
}

/** A shared list (epic #1107) as the scope sees it. */
export interface SourceList {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly listTypeId: string;
  readonly items: readonly ListItem[];
}

/** A list type as the scope sees it. */
export interface SourceListType {
  readonly id: string;
  readonly slug: string;
  readonly def: ListTypeDef;
}

/** A page's list data: what `{{page.props.*}}` and page queries read. */
export interface SourcePageData {
  readonly properties: Readonly<Record<string, unknown>>;
  /** `caelo:term/<listId>/<itemId>` */
  readonly terms: readonly string[];
}

/** Every link-carrying surface of one scope. */
export interface ReferenceSourceModel {
  /** Page id → its template (live pages of the scope only). */
  readonly pageTemplates: ReadonlyMap<string, string>;
  readonly placements: readonly SourcePlacement[];
  readonly modules: ReadonlyMap<string, SourceModule>;
  readonly instances: ReadonlyMap<string, SourceInstance>;
  readonly templates: ReadonlyMap<string, SourceTemplate>;
  readonly layouts: ReadonlyMap<string, SourceLayout>;
  readonly plugins: readonly SourcePluginValue[];
  /** Shared lists by id (deleted ones absent). */
  readonly lists: ReadonlyMap<string, SourceList>;
  /** List types by id (deleted ones absent). */
  readonly listTypes: ReadonlyMap<string, SourceListType>;
  /** Page id → its properties and terms (pages of the scope). */
  readonly pageData: ReadonlyMap<string, SourcePageData>;
}

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function json(raw: unknown): unknown {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/** Narrow a stored `fields` array to the declared fields it holds. */
export function parseSourceFields(raw: unknown): SourceField[] {
  const parsed = json(raw);
  if (!Array.isArray(parsed)) return [];
  const out: SourceField[] = [];
  for (const f of parsed) {
    if (f === null || typeof f !== "object") continue;
    const { name, kind } = f as { name?: unknown; kind?: unknown };
    if (typeof name !== "string" || typeof kind !== "string" || !FIELD_KINDS.has(kind)) continue;
    out.push(f as SourceField);
  }
  return out;
}

function asRecord(raw: unknown): Record<string, unknown> {
  const v = json(raw);
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Live rows visible to the scope (`chat_branch_id` tagged tables). */
function visible(alias: "p" | "m" | "ci" | "t" | "l", branchId: string | null) {
  const a = sql.raw(alias);
  return branchId
    ? sql`(${a}.chat_branch_id IS NULL OR ${a}.chat_branch_id = ${branchId}::uuid)`
    : sql`${a}.chat_branch_id IS NULL`;
}

type OverlayTable =
  | "module_snapshots"
  | "template_snapshots"
  | "content_instance_snapshots"
  | "page_snapshots"
  | "page_layout_snapshots";

/** Latest pending snapshot state per entity of one snapshot table. */
async function overlay(
  tx: TransactionRunner,
  branchId: string,
  table: OverlayTable,
  idColumn: string,
): Promise<Map<string, unknown>> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ON (x.${sql.raw(idColumn)}) x.${sql.raw(idColumn)}::text AS id, x.state
    FROM ${sql.raw(table)} x
    JOIN site_snapshots ss ON ss.id = x.site_snapshot_id
    WHERE ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
    ORDER BY x.${sql.raw(idColumn)}, ss.created_at DESC
  `)) as unknown as { id: string; state: unknown }[];
  return new Map(rows.map((r) => [r.id, parseSnapshotState<unknown>(r.state)]));
}

/**
 * Load the link-carrying surfaces `branchId` sees (null = main line).
 * Plugin values come from every active plugin's `linkLocationsOperation`.
 */
export async function loadReferenceSources(
  tx: TransactionRunner,
  branchId: string | null,
  opts: {
    /**
     * The scope plugins are asked for their link locations in, when it
     * differs from `branchId`. The Stage merge reads main inside its own
     * transaction right after replaying a branch: plugins answer from a
     * separate connection, so they are asked as the branch (whose rows
     * the merge just made main) and core reads the values in-transaction.
     */
    readonly pluginScopeBranchId?: string | null;
  } = {},
): Promise<ReferenceSourceModel> {
  const pageRows = (await tx.execute(sql`
    SELECT p.id::text AS id, p.template_id::text AS template_id
    FROM pages p WHERE p.deleted_at IS NULL AND ${visible("p", branchId)}
  `)) as unknown as { id: string; template_id: string }[];
  const pageTemplates = new Map(pageRows.map((r) => [r.id, r.template_id]));

  const placementRows = (await tx.execute(sql`
    SELECT pm.page_id::text AS page_id, pm.block_name, pm.module_id::text AS module_id,
           pm.content_instance_id::text AS content_instance_id, pm.sync_mode
    FROM page_modules pm
    JOIN pages p ON p.id = pm.page_id AND p.deleted_at IS NULL AND ${visible("p", branchId)}
    ORDER BY pm.page_id, pm.block_name, pm.position
  `)) as unknown as {
    page_id: string;
    block_name: string;
    module_id: string;
    content_instance_id: string | null;
    sync_mode: "synced" | "unsynced" | null;
  }[];
  let placements: SourcePlacement[] = placementRows.map((r) => ({
    pageId: r.page_id,
    blockName: r.block_name,
    moduleId: r.module_id,
    contentInstanceId: r.content_instance_id,
    syncMode: r.content_instance_id === null ? null : r.sync_mode,
  }));

  const moduleRows = (await tx.execute(sql`
    SELECT m.id::text AS id, m.slug, m.display_name, m.html, m.fields
    FROM modules m WHERE m.deleted_at IS NULL AND ${visible("m", branchId)}
  `)) as unknown as {
    id: string;
    slug: string;
    display_name: string;
    html: string;
    fields: unknown;
  }[];
  const modules = new Map<string, SourceModule>(
    moduleRows.map((r) => [
      r.id,
      {
        id: r.id,
        slug: r.slug,
        name: r.display_name,
        html: r.html,
        fields: parseSourceFields(r.fields),
      },
    ]),
  );

  const instanceRows = (await tx.execute(sql`
    SELECT ci.id::text AS id, ci.module_id::text AS module_id, ci."values" AS values
    FROM content_instances ci WHERE ci.deleted_at IS NULL AND ${visible("ci", branchId)}
  `)) as unknown as { id: string; module_id: string; values: unknown }[];
  const instances = new Map<string, SourceInstance>(
    instanceRows.map((r) => [
      r.id,
      { id: r.id, moduleId: r.module_id, values: asRecord(r.values) },
    ]),
  );

  const templateRows = (await tx.execute(sql`
    SELECT t.id::text AS id, t.display_name, t.html, t.layout_id::text AS layout_id
    FROM templates t WHERE t.deleted_at IS NULL AND ${visible("t", branchId)}
  `)) as unknown as { id: string; display_name: string; html: string; layout_id: string | null }[];
  const templates = new Map<string, SourceTemplate>(
    templateRows.map((r) => [
      r.id,
      { id: r.id, name: r.display_name, html: r.html, layoutId: r.layout_id },
    ]),
  );

  const layoutRows = (await tx.execute(sql`
    SELECT l.id::text AS id, l.display_name, l.html
    FROM layouts l WHERE l.deleted_at IS NULL AND ${visible("l", branchId)}
  `)) as unknown as { id: string; display_name: string; html: string }[];
  const layoutBlockRows = (await tx.execute(sql`
    SELECT lm.layout_id::text AS layout_id, lm.block_name, lm.module_id::text AS module_id
    FROM (${effectiveLayoutModulesSql(branchId)}) lm
    ORDER BY lm.layout_id, lm.block_name, lm.position
  `)) as unknown as { layout_id: string; block_name: string; module_id: string }[];
  const blocksByLayout = new Map<string, Map<string, string[]>>();
  for (const r of layoutBlockRows) {
    const perLayout = blocksByLayout.get(r.layout_id) ?? new Map<string, string[]>();
    perLayout.set(r.block_name, [...(perLayout.get(r.block_name) ?? []), r.module_id]);
    blocksByLayout.set(r.layout_id, perLayout);
  }
  const layouts = new Map<string, SourceLayout>(
    layoutRows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.display_name,
        html: r.html,
        blocks: [...(blocksByLayout.get(r.id) ?? new Map<string, string[]>())].map(
          ([blockName, moduleIds]) => ({ blockName, moduleIds }),
        ),
      },
    ]),
  );

  if (branchId) {
    placements = await overlayBranch(tx, branchId, {
      pageTemplates,
      placements,
      modules,
      instances,
      templates,
    });
  }

  // Lists, list types and page data through the same overlay readers the
  // preview uses (lists/store.ts, lists/pages-view.ts).
  const lists = new Map<string, SourceList>(
    (await loadListEntities(tx, "list", branchId)).map((l) => [
      l.id,
      {
        id: l.id,
        slug: l.state.slug,
        name: l.state.name,
        listTypeId: l.state.listTypeId,
        items: l.state.items,
      },
    ]),
  );
  const listTypes = new Map<string, SourceListType>(
    (await loadListEntities(tx, "listType", branchId)).map((t) => [
      t.id,
      { id: t.id, slug: t.state.slug, def: t.state.definition },
    ]),
  );
  const pageData = new Map<string, SourcePageData>(
    (await loadPagesInView(tx, branchId)).map((p) => [
      p.id,
      { properties: p.properties, terms: p.terms },
    ]),
  );

  return {
    pageTemplates,
    placements,
    modules,
    instances,
    templates,
    layouts,
    lists,
    listTypes,
    pageData,
    plugins: await loadPluginValues(
      tx,
      branchId,
      opts.pluginScopeBranchId === undefined ? branchId : opts.pluginScopeBranchId,
      modules,
    ),
  };
}

/**
 * Apply a branch's pending edits on top of the live rows it can see:
 * the latest pending snapshot per entity, as the Stage merge would replay
 * it. Returns the branch's placement list.
 */
async function overlayBranch(
  tx: TransactionRunner,
  branchId: string,
  m: {
    pageTemplates: Map<string, string>;
    placements: SourcePlacement[];
    modules: Map<string, SourceModule>;
    instances: Map<string, SourceInstance>;
    templates: Map<string, SourceTemplate>;
  },
): Promise<SourcePlacement[]> {
  for (const [id, raw] of await overlay(tx, branchId, "module_snapshots", "module_id")) {
    const s = parseAndUpgradeModuleState(raw);
    if (s.deletedAt) m.modules.delete(id);
    else {
      m.modules.set(id, {
        id,
        slug: s.slug,
        name: s.displayName,
        html: s.html,
        fields: parseSourceFields(s.fields),
      });
    }
  }
  for (const [id, raw] of await overlay(tx, branchId, "template_snapshots", "template_id")) {
    const s = parseAndUpgradeTemplateState(raw);
    const live = m.templates.get(id);
    if (s.deletedAt) m.templates.delete(id);
    else
      m.templates.set(id, {
        id,
        name: s.displayName,
        html: s.html,
        layoutId: live?.layoutId ?? null,
      });
  }
  for (const [id, raw] of await overlay(
    tx,
    branchId,
    "content_instance_snapshots",
    "content_instance_id",
  )) {
    const s = raw as { moduleId: string; values: unknown; deletedAt: string | null };
    if (s.deletedAt) m.instances.delete(id);
    else m.instances.set(id, { id, moduleId: s.moduleId, values: asRecord(s.values) });
  }
  for (const [id, raw] of await overlay(tx, branchId, "page_snapshots", "page_id")) {
    const s = raw as { templateId?: string; deletedAt?: string | null };
    if (s.deletedAt) m.pageTemplates.delete(id);
    else if (s.templateId && m.pageTemplates.has(id)) m.pageTemplates.set(id, s.templateId);
  }
  const layoutOverlay = await overlay(tx, branchId, "page_layout_snapshots", "page_id");
  const kept = m.placements.filter(
    (p) => m.pageTemplates.has(p.pageId) && !layoutOverlay.has(p.pageId),
  );
  for (const [pageId, raw] of layoutOverlay) {
    if (!m.pageTemplates.has(pageId)) continue;
    const s = parseAndUpgradePageLayoutState(raw);
    for (const b of s.blocks) {
      if (b.placements) {
        for (const p of b.placements) {
          kept.push({
            pageId,
            blockName: b.blockName,
            moduleId: p.moduleId,
            contentInstanceId: p.contentInstanceId,
            syncMode: p.syncMode,
          });
        }
      } else {
        for (const moduleId of b.moduleIds) {
          kept.push({
            pageId,
            blockName: b.blockName,
            moduleId,
            contentInstanceId: null,
            syncMode: null,
          });
        }
      }
    }
  }
  return kept;
}

/**
 * Plugin-stored link values via the plugins' `linkLocationsOperation`
 * (rollout E's hook): the plugin names the places, core reads them — in
 * the plugin's RLS scope, the branch's pending row state winning on a
 * branch. A failing hook throws (CLAUDE.md §2): the check must not read
 * as clean while a plugin's links went unchecked.
 */
async function loadPluginValues(
  tx: TransactionRunner,
  branchId: string | null,
  locationScope: string | null,
  modules: ReadonlyMap<string, SourceModule>,
): Promise<SourcePluginValue[]> {
  const sets = await collectPluginLinkLocations(
    locationScope ? { chatBranchId: locationScope } : MAIN_RENDER,
  );
  const out: SourcePluginValue[] = [];
  for (const set of sets) {
    if (!IDENT_RE.test(set.schema)) {
      throw new Error(`reference integrity: refusing plugin schema identifier "${set.schema}"`);
    }
    for (const loc of set.locations) {
      const value = await withPluginScope(tx, set.pluginId, async () => {
        if (branchId) {
          const pending = (await tx.execute(sql`
            SELECT prs.state FROM plugin_row_snapshots prs
            JOIN site_snapshots ss ON ss.id = prs.site_snapshot_id
            WHERE prs.plugin_id = ${set.pluginId}::uuid AND prs.table_name = ${loc.table}
              AND prs.row_id = ${loc.rowId}::uuid
              AND ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
            ORDER BY ss.created_at DESC, prs.created_at DESC LIMIT 1
          `)) as unknown as { state: unknown }[];
          const state = pending[0]
            ? (parseSnapshotState(pending[0].state) as {
                values: Record<string, unknown>;
                deletedAt: string | null;
              })
            : null;
          if (state) return state.deletedAt ? undefined : state.values[loc.column];
        }
        // Identifiers: the schema is checked above, the table against the
        // plugin's declared adminSchema and the identifier pattern
        // (collectPluginLinkLocations); the column is a bound parameter.
        const rowScope = branchId
          ? sql`(t."caelo_chat_branch_id" IS NULL OR t."caelo_chat_branch_id" = ${branchId}::uuid)`
          : sql`t."caelo_chat_branch_id" IS NULL`;
        const rows = (await tx.execute(sql`
          SELECT to_jsonb(t.*) -> ${loc.column} AS v
          FROM ${sql.raw(`"${set.schema}"."${loc.table}"`)} AS t
          WHERE t.id = ${loc.rowId}::uuid AND t."caelo_deleted_at" IS NULL AND ${rowScope}
        `)) as unknown as { v: unknown }[];
        return rows[0] === undefined ? undefined : json(rows[0].v);
      });
      if (value === undefined || value === null) continue;
      const fields = loc.fields
        ? parseSourceFields(loc.fields)
        : loc.moduleId
          ? (modules.get(loc.moduleId)?.fields ?? null)
          : null;
      out.push({ pluginSlug: set.pluginSlug, label: loc.label, value, fields });
    }
  }
  return out;
}
