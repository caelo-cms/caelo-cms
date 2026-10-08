// SPDX-License-Identifier: MPL-2.0

/**
 * #592 — the editor preview's side of the content-variants composition
 * point (plugin-host/content-variants.ts). Builds the same placement
 * payload the static generator builds (keys `layout:<block>:<index>` /
 * `page:<block>:<position>`, values = what core would render), asks the
 * contributing plugins, and hands back what to render instead:
 *
 * - page placements: replacement values (rendered through a synthetic
 *   content instance by the caller);
 * - layout placements: replacement values and/or another module, loaded
 *   here with the caller's branch visibility;
 * - problems, as missing-content markers — the build refuses to ship the
 *   same problems.
 */

import {
  contentVariantProblemMarker,
  hasContentVariantContributors,
  type RenderScope,
  resolveContentVariants,
} from "@caelo-cms/plugin-host";
import type { ContentVariantPlacement } from "@caelo-cms/plugin-sdk";
import type { TransactionRunner } from "@caelo-cms/query-api";
import type { PageUrlStyle } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** The module row shape the preview loads (layout and page modules). */
export interface VariantModuleRow {
  block_name: string;
  position: number;
  module_id: string;
  slug: string;
  display_name: string;
  html: string;
  css: string;
  js: string;
  fields: unknown;
}

/** What the preview renders instead of the stored content. */
export interface PreviewContentVariants {
  /** `${block}#${position}` → values for page placements. */
  readonly pageValues: ReadonlyMap<string, Record<string, unknown>>;
  /** `layout:<block>:<index>` → module and/or values for layout placements. */
  readonly layout: ReadonlyMap<
    string,
    { module?: VariantModuleRow; values?: Record<string, unknown> }
  >;
  /** Missing-content markers, one per reported problem. */
  readonly markers: readonly string[];
}

function fieldList(raw: unknown): { name: string; kind: string; default?: unknown }[] {
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((f): f is { name: string; kind?: string; default?: unknown } => {
      return !!f && typeof f === "object" && typeof (f as { name?: unknown }).name === "string";
    })
    .map((f) => ({ name: f.name, kind: f.kind ?? "text", default: f.default }));
}

function defaults(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fieldList(raw)) if (f.default !== undefined) out[f.name] = f.default;
  return out;
}

const NONE: PreviewContentVariants = { pageValues: new Map(), layout: new Map(), markers: [] };

/**
 * Resolve this page's content variants. Costs nothing — no payload, no
 * plugin call — when no plugin contributes.
 */
export async function resolvePreviewContentVariants(
  tx: TransactionRunner,
  input: {
    pageId: string;
    layoutId: string;
    layoutModRows: readonly VariantModuleRow[];
    modRows: readonly VariantModuleRow[];
    placementBindings: ReadonlyMap<string, { contentInstanceId: string; synced: boolean }>;
    valuesByInstance: ReadonlyMap<string, Record<string, unknown>>;
    chatBranchId: string | null;
    renderScope: RenderScope;
    pageUrlStyle: PageUrlStyle;
  },
): Promise<PreviewContentVariants> {
  if (!hasContentVariantContributors()) return NONE;

  const placements: ContentVariantPlacement[] = [];
  const indexInBlock = new Map<string, number>();
  for (const r of input.layoutModRows) {
    const index = indexInBlock.get(r.block_name) ?? 0;
    indexInBlock.set(r.block_name, index + 1);
    placements.push({
      key: `layout:${r.block_name}:${index}`,
      scope: "layout",
      layoutId: input.layoutId,
      blockName: r.block_name,
      position: index,
      moduleId: r.module_id,
      moduleName: r.display_name,
      contentInstanceId: null,
      shared: true,
      fields: fieldList(r.fields).map((f) => ({ name: f.name, kind: f.kind })),
      values: defaults(r.fields),
    });
  }
  const pageKeyOf = new Map<string, string>();
  for (const m of input.modRows) {
    const bindingKey = `${m.block_name}#${m.position}`;
    const binding = input.placementBindings.get(bindingKey);
    if (!binding) continue;
    const key = `page:${m.block_name}:${m.position}`;
    pageKeyOf.set(key, bindingKey);
    placements.push({
      key,
      scope: "page",
      layoutId: null,
      blockName: m.block_name,
      position: m.position,
      moduleId: m.module_id,
      moduleName: m.display_name,
      contentInstanceId: binding.contentInstanceId,
      shared: binding.synced,
      fields: fieldList(m.fields).map((f) => ({ name: f.name, kind: f.kind })),
      values: {
        ...defaults(m.fields),
        ...(input.valuesByInstance.get(binding.contentInstanceId) ?? {}),
      },
    });
  }

  const resolved = (
    await resolveContentVariants(
      [{ pageId: input.pageId, placements }],
      input.renderScope,
      input.pageUrlStyle,
    )
  ).get(input.pageId);
  if (!resolved) return NONE;

  const markers: string[] = [];
  const pageValues = new Map<string, Record<string, unknown>>();
  const layoutRaw = new Map<string, { moduleId?: string; values?: Record<string, unknown> }>();
  for (const [key, res] of resolved) {
    for (const p of res.problems) markers.push(contentVariantProblemMarker(res.pluginSlug, p));
    if (key.startsWith("page:")) {
      const bindingKey = pageKeyOf.get(key);
      if (bindingKey && res.values !== undefined) pageValues.set(bindingKey, { ...res.values });
    } else {
      layoutRaw.set(key, {
        ...(res.moduleId !== undefined ? { moduleId: res.moduleId } : {}),
        ...(res.values !== undefined ? { values: { ...res.values } } : {}),
      });
    }
  }

  const overrideIds = [
    ...new Set([...layoutRaw.values()].flatMap((v) => (v.moduleId ? [v.moduleId] : []))),
  ];
  const modulesById = new Map<string, VariantModuleRow>();
  if (overrideIds.length > 0) {
    const branchScope = input.chatBranchId
      ? sql`AND (chat_branch_id IS NULL OR chat_branch_id = ${input.chatBranchId}::uuid)`
      : sql`AND chat_branch_id IS NULL`;
    const rows = (await tx.execute(sql`
      SELECT id::text AS module_id, slug, display_name, html, css, js, fields
      FROM modules
      WHERE id IN (${sql.join(
        overrideIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) AND deleted_at IS NULL ${branchScope}
    `)) as unknown as Omit<VariantModuleRow, "block_name" | "position">[];
    for (const r of rows) modulesById.set(r.module_id, { ...r, block_name: "", position: 0 });
  }
  const layout = new Map<string, { module?: VariantModuleRow; values?: Record<string, unknown> }>();
  for (const [key, v] of layoutRaw) {
    const module = v.moduleId !== undefined ? modulesById.get(v.moduleId) : undefined;
    if (v.moduleId !== undefined && !module) {
      // The variant names a module this chat cannot see (deleted, or on
      // another chat's branch): say so instead of rendering the source.
      markers.push(
        contentVariantProblemMarker(
          "core",
          `${key} renders module ${v.moduleId}, which does not exist (deleted or on another chat's branch) — point the variant at an existing module`,
        ),
      );
      continue;
    }
    layout.set(key, {
      ...(module ? { module } : {}),
      ...(v.values !== undefined ? { values: v.values } : {}),
    });
  }
  return { pageValues, layout, markers };
}
