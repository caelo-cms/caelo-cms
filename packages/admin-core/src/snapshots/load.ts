// SPDX-License-Identifier: MPL-2.0

/**
 * Helpers that load the *current* state of a content entity for snapshot
 * emission. Called from inside a mutation op handler after the write so the
 * captured state matches what just landed on disk.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { ModuleState, PageLayoutState, PageState, TemplateState } from "./state.js";

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

export async function loadPageLayoutState(
  tx: TransactionRunner,
  pageId: string,
): Promise<PageLayoutState> {
  const rows = (await tx.execute(sql`
    SELECT block_name, position, module_id::text AS module_id
    FROM page_modules WHERE page_id = ${pageId}::uuid
    ORDER BY block_name ASC, position ASC
  `)) as unknown as { block_name: string; position: number; module_id: string }[];
  const grouped = new Map<string, string[]>();
  for (const r of rows) {
    const arr = grouped.get(r.block_name) ?? [];
    arr.push(r.module_id);
    grouped.set(r.block_name, arr);
  }
  return {
    schemaVersion: 1,
    blocks: [...grouped.entries()].map(([blockName, moduleIds]) => ({ blockName, moduleIds })),
  };
}
