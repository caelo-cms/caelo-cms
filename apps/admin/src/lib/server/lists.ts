// SPDX-License-Identifier: MPL-2.0

/**
 * Server side of *Content → Menus & lists* and the page settings' type,
 * properties and terms (epic #1107). Typed wrappers over the list ops so
 * the route files stay about the page, plus the error mapping every write
 * action shares: a stale write (`Conflict: …`) becomes a reload prompt,
 * a type change that would delete values becomes a confirmation, every
 * other refusal is shown as the op wrote it (the messages name the fix).
 */

import { execute } from "@caelo-cms/query-api";
import type {
  ExecutionContext,
  ListItemInput,
  ListTypeDef,
  ListTypeRole,
  PageTypeDef,
} from "@caelo-cms/shared";
import { fail } from "@sveltejs/kit";
import { needsDropValues } from "#lib/lists/type-editor.js";
import { opErrorMessage } from "./op-error.js";
import { getQueryContext } from "./query.js";

/** "Used in": where a shared list renders. */
export interface ListUsage {
  modules: { moduleId: string; slug: string; displayName: string; field: string }[];
  placementCount: number;
  samplePages: { pageId: string; path: string; title: string }[];
  pageTypes: string[];
  taggedPageCount: number;
}

/** One shared list as `lists.list` returns it. */
export interface ListSummary {
  id: string;
  slug: string;
  name: string;
  purpose: string;
  type: string;
  role: ListTypeRole;
  itemCount: number;
  version: number;
  updatedAt: string;
  usage: ListUsage;
}

/** One shared list with its entries (`lists.get`, links humanised). */
export interface ListDetail extends ListSummary {
  items: ListItemInput[];
}

/** One list type as `list_types.list` / `list_types.get` return it. */
export interface ListTypeRow {
  id: string;
  slug: string;
  name: string;
  purpose: string;
  role: ListTypeRole;
  nodes: string[];
  definition: ListTypeDef;
  listCount: number;
  version: number;
  updatedAt: string;
}

/** One page type as `page_types.list` returns it. */
export type PageTypeRow = PageTypeDef & {
  id: string;
  version: number;
  updatedAt: string;
  pageCount: number;
  vocabularySlugs: string[];
};

/** A vocabulary for term pickers: the list and its entries. */
export interface Vocabulary {
  id: string;
  slug: string;
  name: string;
  items: ListItemInput[];
}

async function run<T>(ctx: ExecutionContext, op: string, input: unknown): Promise<T> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) throw new Error(`${op}: ${opErrorMessage(r.error, r.error.kind)}`);
  return r.value as T;
}

/** Run a write op; the Result is returned so the action maps the error. */
export async function runWrite(
  ctx: ExecutionContext,
  op: string,
  input: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string; kind: string }> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, op, input);
  if (r.ok) return { ok: true, value: r.value };
  return { ok: false, kind: r.error.kind, message: opErrorMessage(r.error, `${op} failed.`) };
}

/** Every shared list, optionally of one type. */
export async function loadLists(ctx: ExecutionContext, type?: string): Promise<ListSummary[]> {
  return (await run<{ lists: ListSummary[] }>(ctx, "lists.list", type ? { type } : {})).lists;
}

/** One shared list by slug or id, null when it does not exist. */
export async function loadList(
  ctx: ExecutionContext,
  by: { slug: string } | { id: string },
): Promise<ListDetail | null> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, "lists.get", by);
  return r.ok ? (r.value as { list: ListDetail }).list : null;
}

/** Every list type. */
export async function loadListTypes(ctx: ExecutionContext): Promise<ListTypeRow[]> {
  return (await run<{ listTypes: ListTypeRow[] }>(ctx, "list_types.list", {})).listTypes;
}

/** One list type with the lists that share it, null when it does not exist. */
export async function loadListType(
  ctx: ExecutionContext,
  slug: string,
): Promise<{
  listType: ListTypeRow;
  lists: { id: string; slug: string; name: string }[];
  localLists: string[];
} | null> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, "list_types.get", { slug });
  return r.ok
    ? (r.value as {
        listType: ListTypeRow;
        lists: { id: string; slug: string; name: string }[];
        localLists: string[];
      })
    : null;
}

/** Every page type. */
export async function loadPageTypes(ctx: ExecutionContext): Promise<PageTypeRow[]> {
  return (await run<{ pageTypes: PageTypeRow[] }>(ctx, "page_types.list", {})).pageTypes;
}

/** Every vocabulary list with its entries (term pickers, query term knobs). */
export async function loadVocabularies(ctx: ExecutionContext): Promise<Vocabulary[]> {
  const summaries = (await run<{ lists: ListSummary[] }>(ctx, "lists.list", { role: "vocabulary" }))
    .lists;
  const full = await Promise.all(summaries.map((s) => loadList(ctx, { id: s.id })));
  return full
    .filter((l): l is ListDetail => l !== null)
    .map((l) => ({ id: l.id, slug: l.slug, name: l.name, items: l.items }));
}

/** Pages for link pickers (path + title), sorted by path. */
export async function loadPagePicks(
  ctx: ExecutionContext,
): Promise<{ id: string; path: string; title: string; pageType: string; templateId: string }[]> {
  const pages = (
    await run<{
      pages: {
        id: string;
        currentPath: string;
        title: string;
        pageType: string;
        templateId: string;
      }[];
    }>(ctx, "pages.list", {})
  ).pages;
  return pages
    .map((p) => ({
      id: p.id,
      path: p.currentPath,
      title: p.title,
      pageType: p.pageType,
      templateId: p.templateId,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Modules for embedded-module pickers. */
export async function loadModulePicks(
  ctx: ExecutionContext,
): Promise<{ id: string; slug: string; displayName: string; type: string; description: string }[]> {
  const modules = (
    await run<{
      modules: {
        id: string;
        slug: string;
        displayName: string;
        type: string;
        description: string;
        deletedAt: string | null;
      }[];
    }>(ctx, "modules.list", {})
  ).modules;
  return modules
    .filter((m) => m.deletedAt === null)
    .map(({ id, slug, displayName, type, description }) => ({
      id,
      slug,
      displayName,
      type,
      description,
    }));
}

/** Slugs of the active plugins (plugin-provided editor tabs). */
export async function loadActivePluginSlugs(ctx: ExecutionContext): Promise<string[]> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, "plugins.list", { status: "active" });
  if (!r.ok) return [];
  return (r.value as { plugins: { slug: string }[] }).plugins.map((p) => p.slug);
}

/** Parse a JSON form field, or null when it is missing or not JSON. */
export function jsonField<T>(form: FormData, name: string): T | null {
  const raw = form.get(name);
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** The optimistic version a form sent back, if any. */
export function versionField(form: FormData, name = "expectedVersion"): number | undefined {
  const n = Number.parseInt(String(form.get(name) ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The action result for a refused write. A stale write is a 409 with
 * `conflict` (the page offers a reload instead of a toast loop); a type
 * change that would delete values is a 409 with `dropValuesRequired`
 * (the page asks before resending with `dropValues`); everything else is
 * a 400 with the op's own message.
 */
export function writeFailure(message: string) {
  if (/^conflict\b/i.test(message) || /\bConflict: /.test(message)) {
    return fail(409, { conflict: message });
  }
  if (needsDropValues(message)) return fail(409, { dropValuesRequired: message });
  return fail(400, { error: message });
}

/**
 * Save a list type from the Structure / Types editor: the definition the
 * form sent (its slug forced to `slug` — the editor never renames a type),
 * the version it was loaded at, and `dropValues` once the operator
 * confirmed that the change may delete stored values.
 */
export async function saveListType(ctx: ExecutionContext, slug: string, form: FormData) {
  const definition = jsonField<ListTypeDef>(form, "definition");
  if (!definition)
    return fail(400, { error: "The structure could not be read — reload and retry." });
  const expectedVersion = versionField(form);
  const r = await runWrite(ctx, "list_types.upsert_many", {
    listTypes: [
      { ...definition, slug, ...(expectedVersion !== undefined ? { expectedVersion } : {}) },
    ],
    dropValues: form.get("dropValues") === "true",
  });
  if (!r.ok) return writeFailure(r.message);
  return { ok: "Structure saved." };
}

/** Pickers' data a type editor needs (term fields name vocabularies; defaults may link pages). */
export async function loadTypeEditorContext(ctx: ExecutionContext) {
  const [vocabularies, pages] = await Promise.all([loadVocabularies(ctx), loadPagePicks(ctx)]);
  return { vocabularies, pages };
}

/** Templates for page-type template pickers. */
export async function loadTemplatePicks(
  ctx: ExecutionContext,
): Promise<{ id: string; slug: string; displayName: string }[]> {
  const templates = (
    await run<{ templates: { id: string; slug: string; displayName: string }[] }>(
      ctx,
      "templates.list",
      {},
    )
  ).templates;
  return templates.map(({ id, slug, displayName }) => ({ id, slug, displayName }));
}

/** One page type with sample pages, null when it does not exist. */
export async function loadPageType(
  ctx: ExecutionContext,
  slug: string,
): Promise<{
  pageType: PageTypeRow;
  samplePages: { pageId: string; path: string; title: string }[];
} | null> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, "page_types.get", { slug });
  return r.ok
    ? (r.value as {
        pageType: PageTypeRow;
        samplePages: { pageId: string; path: string; title: string }[];
      })
    : null;
}
