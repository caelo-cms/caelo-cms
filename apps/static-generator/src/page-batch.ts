// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — what the build loads per batch of pages instead of for the whole
 * site at once: the batch's placements (module code + content values),
 * their content variants, nested modules and plugin list sources. Before,
 * all of it was loaded for every page up front and held until the last
 * page was written — memory that grew with the site.
 */

import type { BuildPluginServices } from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type ComposeField,
  type NestedRefValue,
  type NestedRenderResolver,
  type PageUrlStyle,
  templateFieldsFromJson,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import {
  applyContentVariants,
  resolveBuildContentVariants,
  type VariantComposeModule,
} from "./content-variants-pass.js";
import { loadNestedModules } from "./nested-modules-pass.js";

/** One page row of the build (its HTML lives in the template / layout maps). */
export interface PageRow {
  page_id: string;
  slug: string;
  /** The composed public path (pages.current_path, #390). */
  current_path: string;
  title: string;
  status: "draft" | "published";
  template_id: string;
  layout_id: string;
}

/** A page placement as the composer needs it. */
export interface ModuleRow {
  page_id: string;
  block_name: string;
  position: number;
  module_id: string;
  slug: string;
  display_name: string;
  html: string;
  css: string;
  js: string;
  fields: string | null;
  content_values: string | null;
  content_instance_id: string;
  sync_mode: "synced" | "unsynced";
  /** Set once content variants replaced the instance's values: no stored instance renders. */
  variant?: true;
}

/** A layout module as loaded once for the build. */
export interface LayoutModule {
  moduleId: string;
  slug: string;
  displayName: string;
  html: string;
  css: string;
  js: string;
  fields?: ComposeField[];
}

/** A composer block: its modules in order. */
export type ComposeBlock = {
  blockName: string;
  modules: {
    moduleId: string;
    slug: string;
    displayName: string;
    html: string;
    css: string;
    js: string;
    fields?: ComposeField[];
    contentValues?: Record<string, unknown>;
    contentInstanceId?: string;
  }[];
};

/** A JSON value bound as one jsonb parameter. */
function jsonb(value: unknown): ReturnType<typeof sql> {
  return sql`(${JSON.stringify(value)}::text)::jsonb`;
}

/**
 * Parse the jsonb `modules.fields` column as it comes back from
 * `m.fields::text` into the fields the shared template engine renders
 * with (name, kind, default, a `list` field's binding — see
 * `templateFieldsFromJson`). Returns undefined when the column is null /
 * empty / malformed — the caller treats that as "no field-default
 * substitution to do" rather than throwing, so a legacy module with a
 * NULL fields column still ships.
 */
export function parseModuleFields(raw: string | null): ComposeField[] | undefined {
  if (!raw) return undefined;
  try {
    const out = templateFieldsFromJson(JSON.parse(raw));
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse the jsonb `content_instances.values` column. Per-placement
 * override map keyed by module field name — see
 * `renderModuleFields` in `@caelo-cms/shared/preview-compose` for
 * substitution semantics. Returns undefined on null / malformed /
 * non-object so compose falls back to field defaults.
 */
function parseContentValues(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    return Object.keys(obj).length > 0 ? obj : undefined;
  } catch {
    return undefined;
  }
}

/** Placements grouped into composer blocks. */
export function groupModulesByBlock(rows: readonly ModuleRow[]): ComposeBlock[] {
  const grouped = new Map<string, ComposeBlock["modules"]>();
  for (const r of rows) {
    const arr = grouped.get(r.block_name) ?? [];
    arr.push({
      moduleId: r.module_id,
      slug: r.slug,
      displayName: r.display_name,
      html: r.html,
      css: r.css,
      js: r.js,
      fields: parseModuleFields(r.fields),
      contentValues: parseContentValues(r.content_values),
      ...(r.variant ? {} : { contentInstanceId: r.content_instance_id }),
    });
    grouped.set(r.block_name, arr);
  }
  return [...grouped.entries()].map(([blockName, modules]) => ({ blockName, modules }));
}

type Deferrals = Awaited<ReturnType<BuildPluginServices["resolveModuleDeferrals"]>>;
/** One module's verdict (withheld until consent, or why). */
type Deferral = Deferrals extends ReadonlyMap<string, infer V> ? V : never;
/** Plugin list sources per page id. */
type ListSources = Awaited<ReturnType<BuildPluginServices["resolveListSources"]>>;

/** Modules per deferral round-trip: bounds the content values one call carries. */
const DEFERRAL_BATCH = 200;

/**
 * #450 — the modules a plugin withholds (consent), resolved for the whole
 * build: per MODULE, judged on its code plus every main-line content
 * instance. Asked in batches of modules, so the content values in memory
 * at once are a batch's, not the site's.
 */
export async function resolveDeferredModules(
  tx: TransactionRunner,
  plugins: BuildPluginServices,
): Promise<Record<string, Deferral>> {
  // Nothing withholds modules: no candidates to load (and to send over the
  // plugin channel) at all.
  if (!(await plugins.hasDeferralContributors())) return {};
  const ids = (await tx.execute(sql`
    SELECT m.id::text AS id FROM modules m WHERE m.deleted_at IS NULL ORDER BY m.id
  `)) as unknown as { id: string }[];
  const out: Record<string, Deferral> = {};
  for (let at = 0; at < ids.length; at += DEFERRAL_BATCH) {
    const batch = ids.slice(at, at + DEFERRAL_BATCH).map((r) => r.id);
    const rows = (await tx.execute(sql`
      SELECT m.id::text AS id, m.html, m.css, m.js, m.fields::text AS fields,
             COALESCE(
               json_agg(ci.values) FILTER (WHERE ci.id IS NOT NULL),
               '[]'::json
             )::text AS content_values
      FROM modules m
        LEFT JOIN content_instances ci
          ON ci.module_id = m.id AND ci.chat_branch_id IS NULL
      WHERE m.id IN (SELECT jsonb_array_elements_text(${jsonb(batch)})::uuid)
        AND m.deleted_at IS NULL
      GROUP BY m.id
    `)) as unknown as {
      id: string;
      html: string;
      css: string;
      js: string;
      fields: string | null;
      content_values: string;
    }[];
    const verdicts = await plugins.resolveModuleDeferrals(
      rows.map((r) => ({
        moduleId: r.id,
        html: r.html,
        css: r.css,
        js: r.js,
        fields: r.fields ? JSON.parse(r.fields) : [],
        contentValues: JSON.parse(r.content_values) as unknown[],
      })),
    );
    for (const [moduleId, verdict] of verdicts) out[moduleId] = verdict;
  }
  return out;
}

/** What one batch of pages needs to compose. */
export interface LoadedBatch {
  /** Per page: its blocks and the layout's, content variants applied. */
  readonly composeInputs: ReadonlyMap<
    string,
    {
      blocks: ComposeBlock[];
      layoutBlocks: ReturnType<typeof applyContentVariants>["layoutBlocks"];
    }
  >;
  readonly nestedModules: NestedRenderResolver;
  /** Plugin list sources per page. */
  readonly sources: ListSources;
}

/**
 * Load one batch of pages: placements in one statement, the batch's
 * content variants in one plugin call (#592), nested modules (cards in a
 * grid, plans in a pricing table, modules in shared list entries) and the
 * plugin list sources.
 */
export async function loadBatch(args: {
  readonly tx: TransactionRunner;
  readonly plugins: BuildPluginServices;
  readonly batch: readonly PageRow[];
  readonly layoutModulesByLayout: ReadonlyMap<string, Map<string, LayoutModule[]>>;
  readonly noLayoutModules: ReadonlyMap<string, VariantComposeModule[]>;
  readonly listModuleRefs: readonly NestedRefValue[];
  readonly pageUrlStyle: PageUrlStyle;
}): Promise<LoadedBatch> {
  const { tx, plugins, batch } = args;
  const ids = batch.map((p) => p.page_id);
  const modRows = (await tx.execute(sql`
    SELECT pm.page_id::text AS page_id, pm.block_name, pm.position,
           m.id::text AS module_id,
           m.slug, m.display_name, m.html, m.css, m.js, m.fields::text AS fields,
           ci.values::text AS content_values,
           pm.content_instance_id::text AS content_instance_id,
           pm.sync_mode
    FROM page_modules pm
      JOIN modules m            ON m.id  = pm.module_id
      -- PR #61 follow-up — every placement carries a
      -- content_instance_id (page_modules schema, v0.12.0); join
      -- is INNER because the column is NOT NULL. ci.values fills
      -- the module's curly-brace placeholders.
      JOIN content_instances ci ON ci.id = pm.content_instance_id
    WHERE pm.page_id IN (SELECT jsonb_array_elements_text(${jsonb(ids)})::uuid)
      AND m.deleted_at IS NULL
      -- v0.9.0 — main-only.
      AND m.chat_branch_id IS NULL
    ORDER BY pm.page_id, pm.block_name ASC, pm.position ASC
  `)) as unknown as ModuleRow[];
  const modRowsByPage = new Map<string, ModuleRow[]>();
  for (const r of modRows) {
    const list = modRowsByPage.get(r.page_id);
    if (list) list.push(r);
    else modRowsByPage.set(r.page_id, [r]);
  }
  const layoutOf = (page: PageRow) =>
    args.layoutModulesByLayout.get(page.layout_id) ?? args.noLayoutModules;
  const variants = await resolveBuildContentVariants(
    tx,
    plugins,
    batch.map((page) => ({
      pageId: page.page_id,
      slug: page.slug,
      layoutId: page.layout_id,
      layoutBlocks: layoutOf(page),
      pageBlocks: (modRowsByPage.get(page.page_id) ?? []).map((r) => ({
        blockName: r.block_name,
        position: r.position,
        module: {
          moduleId: r.module_id,
          slug: r.slug,
          displayName: r.display_name,
          html: r.html,
          css: r.css,
          js: r.js,
          fields: parseModuleFields(r.fields),
          contentValues: parseContentValues(r.content_values),
        },
        contentInstanceId: r.content_instance_id,
        synced: r.sync_mode === "synced",
      })),
    })),
  );
  // Every page's blocks as the composer will receive them (content
  // variants applied), so the nested-module load below sees exactly the
  // values that render.
  const composeInputs = new Map<
    string,
    {
      blocks: ComposeBlock[];
      layoutBlocks: ReturnType<typeof applyContentVariants>["layoutBlocks"];
    }
  >();
  for (const page of batch) {
    const rows = modRowsByPage.get(page.page_id) ?? [];
    const applied = applyContentVariants(
      page.page_id,
      layoutOf(page),
      rows,
      variants.resolutions,
      variants.overrideModules,
    );
    const blocks = groupModulesByBlock(
      rows.map((r) => {
        const values = applied.pageValues.get(r);
        // Variant content is no stored instance: its local list entries
        // carry no instance address (`docs/lists.md` §13).
        return values === undefined
          ? r
          : { ...r, content_values: JSON.stringify(values), variant: true as const };
      }),
    );
    composeInputs.set(page.page_id, { blocks, layoutBlocks: applied.layoutBlocks });
  }
  // Modules reached only through a module / module-list field have no
  // placement row of their own; load them so the composer renders them
  // recursively, exactly as the editor preview does.
  const nestedModules = await loadNestedModules(
    tx,
    [...composeInputs.values()].flatMap((c) =>
      [...c.blocks, ...c.layoutBlocks].flatMap((b) => b.modules),
    ),
    args.listModuleRefs,
  );
  const sources = await plugins.resolveListSources(ids, args.pageUrlStyle);
  return { composeInputs, nestedModules, sources };
}
