// SPDX-License-Identifier: MPL-2.0

/**
 * #592 — the static build's side of the content-variants composition
 * point (plugin-host/content-variants.ts): which chrome and which shared
 * content each page ships.
 *
 * One batched resolution for the whole build, before composition. A
 * placement answer replaces the placement's values (layout chrome and
 * page placements) or — layout only — the module itself. Any problem a
 * plugin reports (e.g. no footer in the page's language) stops the build
 * with every problem listed: the editor preview flags the same problems,
 * so nothing here is a surprise, and shipping the source language in
 * their place is exactly the silent fallback CLAUDE.md §2 forbids.
 */

import {
  type ContentVariantPlacement,
  contentVariantProblemMarker,
  hasContentVariantContributors,
  MAIN_RENDER,
  type ResolvedContentVariants,
  resolveContentVariants,
} from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ModuleFieldKind, PageUrlStyle } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** A module as the composer consumes it (layout or page block entry). */
export interface VariantComposeModule {
  moduleId: string;
  slug: string;
  displayName: string;
  html: string;
  css: string;
  js: string;
  fields?: { name: string; kind?: ModuleFieldKind; default?: unknown }[];
  contentValues?: Record<string, unknown>;
}

/** One page of the build as the pass needs it. */
export interface VariantPassPage {
  readonly pageId: string;
  readonly slug: string;
  readonly layoutId: string;
  readonly layoutBlocks: ReadonlyMap<string, readonly VariantComposeModule[]>;
  readonly pageBlocks: ReadonlyArray<{
    readonly blockName: string;
    readonly position: number;
    readonly module: VariantComposeModule;
    readonly contentInstanceId: string;
    readonly synced: boolean;
  }>;
}

/** Field defaults as a values object — what a layout module renders. */
function defaultsOf(m: VariantComposeModule): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of m.fields ?? []) if (f.default !== undefined) out[f.name] = f.default;
  return out;
}

function fieldsOf(m: VariantComposeModule): { name: string; kind: string }[] {
  return (m.fields ?? []).map((f) => ({ name: f.name, kind: f.kind ?? "text" }));
}

/** The placement payload for one page — same keys the preview builds. */
export function variantPlacementsOf(page: VariantPassPage): ContentVariantPlacement[] {
  const out: ContentVariantPlacement[] = [];
  for (const [blockName, modules] of page.layoutBlocks) {
    modules.forEach((m, position) => {
      out.push({
        key: `layout:${blockName}:${position}`,
        scope: "layout",
        layoutId: page.layoutId,
        blockName,
        position,
        moduleId: m.moduleId,
        moduleName: m.displayName,
        contentInstanceId: null,
        shared: true,
        fields: fieldsOf(m),
        values: { ...defaultsOf(m), ...(m.contentValues ?? {}) },
      });
    });
  }
  for (const b of page.pageBlocks) {
    out.push({
      key: `page:${b.blockName}:${b.position}`,
      scope: "page",
      layoutId: null,
      blockName: b.blockName,
      position: b.position,
      moduleId: b.module.moduleId,
      moduleName: b.module.displayName,
      contentInstanceId: b.contentInstanceId,
      shared: b.synced,
      fields: fieldsOf(b.module),
      values: { ...defaultsOf(b.module), ...(b.module.contentValues ?? {}) },
    });
  }
  return out;
}

/**
 * Resolve the whole build's variants and load every override module.
 * Throws when any plugin reported a problem — the message lists them all
 * with the page each one is on.
 */
export async function resolveBuildContentVariants(
  tx: TransactionRunner,
  pages: ReadonlyArray<VariantPassPage>,
  pageUrlStyle: PageUrlStyle,
): Promise<{
  resolutions: ResolvedContentVariants;
  overrideModules: ReadonlyMap<string, VariantComposeModule>;
}> {
  const empty = { resolutions: new Map(), overrideModules: new Map() };
  if (pages.length === 0 || !hasContentVariantContributors()) return empty;
  const resolutions = await resolveContentVariants(
    pages.map((p) => ({ pageId: p.pageId, placements: variantPlacementsOf(p) })),
    MAIN_RENDER,
    pageUrlStyle,
  );

  const problems: string[] = [];
  const overrideIds = new Set<string>();
  for (const page of pages) {
    for (const [key, res] of resolutions.get(page.pageId) ?? []) {
      for (const problem of res.problems) {
        problems.push(
          `page "${page.slug}" (${key}): ${contentVariantProblemMarker(res.pluginSlug, problem)}`,
        );
      }
      if (res.moduleId !== undefined) overrideIds.add(res.moduleId);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `static-generator: ${problems.length} page placement(s) have no content to ship in their page's variant — ${problems.join("; ")}. ` +
        "The editor preview lists the same problems on the missing-content surface; fix them (e.g. ask the AI to translate the site chrome), then publish again.",
    );
  }

  const overrideModules = new Map<string, VariantComposeModule>();
  if (overrideIds.size > 0) {
    const rows = (await tx.execute(sql`
      SELECT id::text AS module_id, slug, display_name, html, css, js, fields::text AS fields
      FROM modules
      WHERE id IN (${sql.join(
        [...overrideIds].map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND deleted_at IS NULL AND chat_branch_id IS NULL
    `)) as unknown as {
      module_id: string;
      slug: string;
      display_name: string;
      html: string;
      css: string;
      js: string;
      fields: string | null;
    }[];
    for (const r of rows) {
      const parsed = r.fields ? (JSON.parse(r.fields) as unknown) : [];
      overrideModules.set(r.module_id, {
        moduleId: r.module_id,
        slug: r.slug,
        displayName: r.display_name,
        html: r.html,
        css: r.css,
        js: r.js,
        fields: Array.isArray(parsed)
          ? (parsed as { name: string; kind?: ModuleFieldKind; default?: unknown }[])
          : [],
      });
    }
    const missing = [...overrideIds].filter((id) => !overrideModules.has(id));
    if (missing.length > 0) {
      throw new Error(
        `static-generator: a content variant renders module(s) ${missing.join(", ")}, which no longer exist on the live site. Point the variant at an existing module, then publish again.`,
      );
    }
  }
  return { resolutions, overrideModules };
}

/**
 * Apply one page's resolutions: layout blocks (module swap and/or
 * values) and page placements (values). Returns new structures; the
 * build-wide layout map is shared between pages and must stay intact.
 */
export function applyContentVariants<P extends { block_name: string; position: number }>(
  pageId: string,
  layoutBlocks: ReadonlyMap<string, readonly VariantComposeModule[]>,
  pageRows: readonly P[],
  resolutions: ResolvedContentVariants,
  overrideModules: ReadonlyMap<string, VariantComposeModule>,
): {
  layoutBlocks: { blockName: string; modules: VariantComposeModule[] }[];
  pageValues: Map<P, Record<string, unknown>>;
} {
  const perPage = resolutions.get(pageId);
  const layout = [...layoutBlocks.entries()].map(([blockName, modules]) => ({
    blockName,
    modules: modules.map((m, position) => {
      const res = perPage?.get(`layout:${blockName}:${position}`);
      if (!res) return m;
      const base = res.moduleId !== undefined ? overrideModules.get(res.moduleId) : m;
      if (!base) {
        throw new Error(`content-variants: override module ${res.moduleId} was not loaded`);
      }
      return res.values !== undefined ? { ...base, contentValues: { ...res.values } } : base;
    }),
  }));
  const pageValues = new Map<P, Record<string, unknown>>();
  for (const row of pageRows) {
    const res = perPage?.get(`page:${row.block_name}:${row.position}`);
    if (res?.values !== undefined) pageValues.set(row, { ...res.values });
  }
  return { layoutBlocks: layout, pageValues };
}
