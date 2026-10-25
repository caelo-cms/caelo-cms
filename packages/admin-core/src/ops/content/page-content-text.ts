// SPDX-License-Identifier: MPL-2.0

/**
 * The core text of pages — what the page's OWN content says, without the
 * layout chrome (header, footer, nav) every page shares. The AI writes a
 * meta description from it (`pages_seo.get_many` → `get_page_seo`).
 *
 * Why not the composed page: `pages.render_preview` composes layout,
 * theme, fonts, plugin data and CSS into 50–200 KB of HTML, and the
 * chrome text it adds is the same on every page — noise for a
 * page-specific 160-character description. This renders only the page's
 * template-block placements, through the same recursive renderer the
 * preview and the static generator use (`renderModuleWithContent`, so
 * nested module / module-list children and field defaults come out as
 * on the page), then strips the result to text.
 *
 * Branch view: the caller's chat branch, same overlays the content reads
 * use — the page's placements (`loadPageLayoutStateWithBranchOverlay`),
 * module code (`loadBranchedModuleStates`) and instance values
 * (`loadContentInstanceBranchStates`), each "latest pending branch
 * snapshot wins over the live row". Without a branch: the live rows.
 *
 * Left out on purpose: theme asset URLs, plugin data lists, internal-link
 * resolution and content variants (#592) — they only change attributes or
 * plugin-fed lists, not the page's own words.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  collectNestedRefs,
  listSlotNames,
  type ModuleFieldKind,
  type NestedContentInstanceResource,
  type NestedModuleResource,
  renderModuleWithContent,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../../draft.js";
import {
  loadBranchedModuleStates,
  loadContentInstanceBranchStates,
  loadPageLayoutStateWithBranchOverlay,
} from "../../snapshots/load.js";
import { capPlainText, htmlToPlainText } from "./plain-text.js";

/** Characters of core text returned per page — enough for a 160-char description. */
export const PAGE_CONTENT_TEXT_MAX = 1500;

/** One page's identity plus its core text. */
export interface PageContentText {
  readonly pageId: string;
  readonly title: string;
  readonly path: string;
  /** Plain text of the page's own content, capped at {@link PAGE_CONTENT_TEXT_MAX}. */
  readonly contentText: string;
  /** True when `contentText` was cut (it then ends with `…`). */
  readonly contentTextTruncated: boolean;
  /** Length of the full text before the cut. */
  readonly contentTextLength: number;
}

/** The texts found, and the ids the caller cannot see (unknown, deleted, or another chat's). */
export interface PageContentTexts {
  readonly pages: readonly PageContentText[];
  readonly missing: readonly string[];
}

const idList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

const parseJson = (raw: unknown): unknown => (typeof raw === "string" ? JSON.parse(raw) : raw);

function parseFields(raw: unknown): NestedModuleResource["fields"] {
  const arr = parseJson(raw);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(
      (f): f is { name: string; kind?: unknown; default?: unknown } =>
        typeof f === "object" && f !== null && typeof (f as { name?: unknown }).name === "string",
    )
    .map((f) => ({
      name: f.name,
      // Same raw-jsonb boundary as the preview: an unknown kind stays loud
      // in the renderer instead of being smoothed over here.
      kind: (typeof f.kind === "string" ? f.kind : "text") as ModuleFieldKind,
      default: f.default,
    }));
}

interface PageRow {
  id: string;
  title: string;
  current_path: string;
  template_html: string;
}

/** The visible pages with their template html; a branch's pending title / delete applied. */
async function loadPageRows(
  tx: TransactionRunner,
  pageIds: readonly string[],
  chatBranchId: string | null,
): Promise<Map<string, PageRow>> {
  const visibility = chatBranchId
    ? sql`AND (p.chat_branch_id IS NULL OR p.chat_branch_id = ${chatBranchId}::uuid)
          AND (t.chat_branch_id IS NULL OR t.chat_branch_id = ${chatBranchId}::uuid)`
    : sql`AND p.chat_branch_id IS NULL AND t.chat_branch_id IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT p.id::text AS id, p.title, p.current_path, t.html AS template_html
      FROM pages p JOIN templates t ON t.id = p.template_id
     WHERE p.id IN (${idList(pageIds)}) AND p.deleted_at IS NULL ${visibility}
  `)) as unknown as PageRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (chatBranchId && rows.length > 0) {
    const snaps = (await tx.execute(sql`
      SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS page_id, ps.state
        FROM page_snapshots ps
        JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
       WHERE ss.chat_branch_id = ${chatBranchId}::uuid AND ${pendingSnapshotSql()}
         AND ps.page_id IN (${idList([...byId.keys()])})
       ORDER BY ps.page_id, ss.created_at DESC
    `)) as unknown as { page_id: string; state: unknown }[];
    for (const s of snaps) {
      const state = parseJson(s.state) as { title?: string; deletedAt?: string | null };
      if (state.deletedAt) byId.delete(s.page_id);
      else if (state.title) {
        const row = byId.get(s.page_id);
        if (row) row.title = state.title;
      }
    }
  }
  return byId;
}

/** Load modules (code + fields) into `out`, the branch's pending edits applied. */
async function loadModules(
  tx: TransactionRunner,
  moduleIds: readonly string[],
  chatBranchId: string | null,
  out: Map<string, NestedModuleResource>,
): Promise<void> {
  const ids = moduleIds.filter((id) => !out.has(id));
  if (ids.length === 0) return;
  const visibility = chatBranchId
    ? sql`AND (chat_branch_id IS NULL OR chat_branch_id = ${chatBranchId}::uuid)`
    : sql`AND chat_branch_id IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, slug, html, css, js, fields
      FROM modules WHERE id IN (${idList(ids)}) AND deleted_at IS NULL ${visibility}
  `)) as unknown as {
    id: string;
    slug: string;
    html: string;
    css: string;
    js: string;
    fields: unknown;
  }[];
  const branched = chatBranchId ? await loadBranchedModuleStates(tx, chatBranchId, ids) : null;
  for (const r of rows) {
    const s = branched?.get(r.id);
    const live = s === undefined || s.deletedAt !== null ? null : s;
    out.set(r.id, {
      moduleId: r.id,
      slug: live?.slug ?? r.slug,
      html: live?.html ?? r.html,
      css: live?.css ?? r.css,
      js: live?.js ?? r.js,
      fields: parseFields(live?.fields ?? r.fields),
    });
  }
}

/** Load content instances (values) into `out`, the branch's pending edits applied. */
async function loadInstances(
  tx: TransactionRunner,
  instanceIds: readonly string[],
  chatBranchId: string | null,
  out: Map<string, NestedContentInstanceResource>,
): Promise<void> {
  const ids = instanceIds.filter((id) => !out.has(id));
  if (ids.length === 0) return;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, module_id::text AS module_id, "values" AS values
      FROM content_instances WHERE id IN (${idList(ids)}) AND deleted_at IS NULL
  `)) as unknown as { id: string; module_id: string; values: unknown }[];
  const branched = chatBranchId
    ? await loadContentInstanceBranchStates(tx, ids, chatBranchId)
    : null;
  for (const r of rows) {
    const s = branched?.get(r.id);
    if (s?.deletedAt) continue;
    const values = s?.values ?? ((parseJson(r.values) ?? {}) as Record<string, unknown>);
    out.set(r.id, { id: r.id, moduleId: r.module_id, values, deletedAt: null });
  }
}

/**
 * The core text of each page in `pageIds`, in input order (duplicates
 * once). Renders nothing when any id is missing: the caller refuses the
 * whole read and names those ids.
 *
 * @param chatBranchId the caller's chat branch (its pending edits show), or
 *   null for the live state.
 */
export async function loadPageContentTexts(
  tx: TransactionRunner,
  pageIds: readonly string[],
  chatBranchId: string | null,
): Promise<PageContentTexts> {
  const unique = [...new Set(pageIds)];
  const pages = await loadPageRows(tx, unique, chatBranchId);
  const missing = unique.filter((id) => !pages.has(id));
  if (missing.length > 0) return { pages: [], missing };

  // Each page's placements in render order: the template's slot order,
  // then each block's position. A block without a slot in the template
  // renders nowhere, so it contributes no text either.
  const placementsByPage = new Map<string, { moduleId: string; contentInstanceId: string }[]>();
  for (const pageId of unique) {
    const layout = await loadPageLayoutStateWithBranchOverlay(tx, pageId, chatBranchId);
    const byBlock = new Map(layout.blocks.map((b) => [b.blockName, b.placements ?? []]));
    const template = pages.get(pageId)?.template_html ?? "";
    placementsByPage.set(
      pageId,
      [...new Set(listSlotNames(template))].flatMap((name) => byBlock.get(name) ?? []),
    );
  }

  const modules = new Map<string, NestedModuleResource>();
  const instances = new Map<string, NestedContentInstanceResource>();
  let moduleIds = [...placementsByPage.values()].flat().map((p) => p.moduleId);
  let instanceIds = [...placementsByPage.values()].flat().map((p) => p.contentInstanceId);
  // Nested children (module / module-list fields) are loaded breadth-first
  // so the renderer never waits on I/O; the renderer itself caps the depth
  // at 8, so 8 rounds load everything it can reach.
  for (let round = 0; round < 9 && (moduleIds.length > 0 || instanceIds.length > 0); round += 1) {
    await loadModules(tx, moduleIds, chatBranchId, modules);
    const before = new Set(instances.keys());
    await loadInstances(tx, instanceIds, chatBranchId, instances);
    const refs = [...instances.entries()]
      .filter(([id]) => !before.has(id))
      .flatMap(([, ci]) => collectNestedRefs(ci.values));
    moduleIds = refs.map((r) => r.moduleId).filter((id) => !modules.has(id));
    instanceIds = refs.map((r) => r.contentInstanceId).filter((id) => !instances.has(id));
  }

  const resolver = {
    getModule: (id: string) => modules.get(id) ?? null,
    getContentInstance: (id: string) => instances.get(id) ?? null,
  };
  const texts = unique.map((pageId) => {
    const page = pages.get(pageId) as PageRow;
    const html = (placementsByPage.get(pageId) ?? [])
      .filter((p) => modules.has(p.moduleId) && instances.has(p.contentInstanceId))
      .map((p) => renderModuleWithContent(p.moduleId, p.contentInstanceId, resolver).html)
      .join("\n");
    const full = htmlToPlainText(html);
    const capped = capPlainText(full, PAGE_CONTENT_TEXT_MAX);
    return {
      pageId,
      title: page.title,
      path: page.current_path,
      contentText: capped.text,
      contentTextTruncated: capped.truncated,
      contentTextLength: full.length,
    };
  });
  return { pages: texts, missing: [] };
}
