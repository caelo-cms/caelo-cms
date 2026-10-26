// SPDX-License-Identifier: MPL-2.0

/**
 * The tag operations: register, change, list, remove, and bake for the
 * runtime.
 *
 * ## Why a tag change re-asks every visitor
 *
 * A visitor who granted "analytics" agreed to the vendors that category
 * held THEN. Adding a vendor to it, moving one between categories, or
 * changing which cookies one sets or where it runs widens what that old
 * consent would cover, so the policy version moves in the same operation
 * (#1137) and every stored decision stops counting. The maintainer chose
 * a global bump over a per-category one: a visitor's decision is one
 * record, and partial re-asking would show a banner whose other answers
 * are silently carried over. Removing a tag only narrows what runs, so it
 * re-asks nobody.
 */

import { z } from "@caelo-cms/plugin-sdk";
import {
  adminQueryOf,
  bumpPolicyVersion,
  type CmsHandle,
  categoriesOf,
  cmsOf,
  touchDeclaration,
} from "./storage.js";
import {
  type BakedTag,
  cookieLabel,
  declarationGaps,
  describeIssues,
  fieldsOfRow,
  resolveTagColumns,
  type TagColumns,
  type TagRow,
  type TagScope,
  tagFieldsSchema,
} from "./tags.js";
import { VENDOR_TEMPLATES } from "./vendors.js";

/** More than any real site registers; `list` reads them in one call. */
const MAX_TAGS = 200;

const tagName = z.string().trim().min(1).max(128);
const addTagArgs = tagFieldsSchema.extend({ name: tagName }).strict();
const updateTagsArgs = z
  .object({
    tags: z
      .array(tagFieldsSchema.extend({ name: tagName, enabled: z.boolean().optional() }).strict())
      .min(1)
      .max(50),
  })
  .strict();

/** What visitors are told happens next, in the operator's words. */
const REASK_NOTE =
  "The consent policy version moved, so every visitor is asked again on their next page view — a consent given before did not cover this change.";

async function allTags(ctx: unknown): Promise<TagRow[]> {
  return (await adminQueryOf(ctx).list("tags", { limit: MAX_TAGS })) as unknown as TagRow[];
}

interface PageRef {
  id: string;
  currentPath: string;
  templateId: string;
}

async function pagesOf(cms: CmsHandle): Promise<PageRef[]> {
  return (await cms.call<{ pages: PageRef[] }>("pages.list", {})).pages;
}

async function templateIdsOf(cms: CmsHandle): Promise<Set<string>> {
  const r = await cms.call<{ templates: Array<{ id: string }> }>("templates.list", {});
  return new Set(r.templates.map((t) => t.id));
}

function scopeIds(scope: TagScope): { pages: string[]; templates: string[] } {
  return {
    pages: [...(scope.pageIds ?? []), ...(scope.excludePageIds ?? [])],
    templates: [...(scope.templateIds ?? []), ...(scope.excludeTemplateIds ?? [])],
  };
}

/** The ids in a scope that name no page or template, as one readable list. */
async function unknownScopeIds(
  cms: CmsHandle,
  scopes: ReadonlyArray<TagScope>,
): Promise<{
  pages: Set<string>;
  templates: Set<string>;
}> {
  const wanted = scopes.map(scopeIds);
  const needPages = wanted.some((w) => w.pages.length > 0);
  const needTemplates = wanted.some((w) => w.templates.length > 0);
  const pageIds = needPages ? new Set((await pagesOf(cms)).map((p) => p.id)) : new Set<string>();
  const templateIds = needTemplates ? await templateIdsOf(cms) : new Set<string>();
  return {
    pages: new Set(wanted.flatMap((w) => w.pages).filter((id) => !pageIds.has(id))),
    templates: new Set(wanted.flatMap((w) => w.templates).filter((id) => !templateIds.has(id))),
  };
}

/** Fail loudly on a scope naming pages or templates that do not exist. */
async function assertScopeIds(cms: CmsHandle, tool: string, scope: TagScope): Promise<void> {
  const unknown = await unknownScopeIds(cms, [scope]);
  const parts = [
    ...(unknown.pages.size > 0 ? [`page ids ${[...unknown.pages].join(", ")}`] : []),
    ...(unknown.templates.size > 0 ? [`template ids ${[...unknown.templates].join(", ")}`] : []),
  ];
  if (parts.length > 0) {
    throw new Error(
      `${tool}: the scope names ${parts.join(" and ")}, which do not exist. Look them up with list_pages / list_templates, or scope by path (\`paths\`, e.g. "/de/*").`,
    );
  }
}

/** Whether a change widens or redirects what a past consent covered (see the file header). */
function changesWhatConsentCovers(before: TagRow, after: TagColumns, enabled: boolean): boolean {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (
    (!before.enabled && enabled) ||
    before.category_key !== after.category_key ||
    before.vendor !== after.vendor ||
    !same(before.vendor_info?.purpose, after.vendor_info.purpose) ||
    !same(before.cookies ?? [], after.cookies) ||
    !same(before.scope ?? {}, after.scope)
  );
}

/**
 * Register a tag. Gated at the tool layer (#452): the SDK pauses for the
 * Owner's in-chat Approve before this runs. The §11.A test is "can the
 * user undo it with one tool call?" — deleting the tag, yes; the data
 * already sent to the vendor, no.
 */
export async function addTag(ctx: unknown, args: unknown) {
  const parsed = addTagArgs.safeParse(args);
  if (!parsed.success) throw new Error(describeIssues("add_tag", parsed.error));
  const { name, ...fields } = parsed.data;
  const q = adminQueryOf(ctx);
  const known = new Set((await categoriesOf(q)).map((c) => c.key));
  const columns = resolveTagColumns("add_tag", fields, known);
  await assertScopeIds(cmsOf(ctx), "add_tag", columns.scope);
  const existing = (await q.list("tags", { name, limit: 1 })) as unknown as TagRow[];
  if (existing[0]) {
    throw new Error(
      `add_tag: a tag named "${name}" already exists — change it with update_tags_many, or pick another name`,
    );
  }
  const r = await q.insert("tags", {
    ...columns,
    name,
    enabled: true,
    updated_at: new Date().toISOString(),
  });
  const policyVersion = await bumpPolicyVersion(q);
  return {
    tagId: r.id,
    name,
    category: columns.category_key,
    config: columns.config,
    policyVersion,
    note: REASK_NOTE,
    declarationGaps: declarationGaps(columns),
  };
}

/**
 * Change several tags at once (CLAUDE.md §11). Every item is validated
 * before anything is written, so one bad item leaves all tags as they
 * were; the policy version moves once for the whole batch.
 */
export async function updateTagsMany(ctx: unknown, args: unknown) {
  const parsed = updateTagsArgs.safeParse(args);
  if (!parsed.success) throw new Error(describeIssues("update_tags_many", parsed.error));
  const q = adminQueryOf(ctx);
  const cms = cmsOf(ctx);
  const known = new Set((await categoriesOf(q)).map((c) => c.key));
  const byName = new Map((await allTags(ctx)).map((t) => [t.name, t]));
  const seen = new Set<string>();
  const planned: Array<{ row: TagRow; columns: TagColumns; enabled: boolean; reasks: boolean }> =
    [];
  for (const item of parsed.data.tags) {
    const { name, enabled, ...patch } = item;
    if (seen.has(name))
      throw new Error(`update_tags_many: "${name}" appears twice — merge the two changes`);
    seen.add(name);
    const row = byName.get(name);
    if (!row) {
      throw new Error(
        `update_tags_many: no tag named "${name}". Registered: ${[...byName.keys()].join(", ") || "(none)"} — add new ones with add_tracking_tag.`,
      );
    }
    // Switching to a known vendor replaces hand-written code with the
    // template's, so the stored code must not ride into the merge.
    const base = fieldsOfRow(row);
    if (patch.config !== undefined) {
      delete base.scriptSrc;
      delete base.inlineSnippet;
    }
    if (patch.scriptSrc !== undefined || patch.inlineSnippet !== undefined) delete base.config;
    const columns = resolveTagColumns("update_tags_many", { ...base, ...patch }, known);
    if (patch.scope !== undefined) await assertScopeIds(cms, "update_tags_many", columns.scope);
    const nextEnabled = enabled ?? row.enabled;
    planned.push({
      row,
      columns,
      enabled: nextEnabled,
      reasks: changesWhatConsentCovers(row, columns, nextEnabled),
    });
  }
  const now = new Date().toISOString();
  for (const p of planned) {
    await q.update("tags", p.row.id, { ...p.columns, enabled: p.enabled, updated_at: now });
  }
  const reasked = planned.some((p) => p.reasks);
  const policyVersion = reasked ? await bumpPolicyVersion(q) : null;
  if (!reasked) await touchDeclaration(q);
  return {
    updated: planned.map((p) => ({
      name: p.row.name,
      category: p.columns.category_key,
      enabled: p.enabled,
      declarationGaps: declarationGaps(p.columns),
    })),
    ...(policyVersion !== null
      ? { policyVersion, note: REASK_NOTE }
      : { note: "Nothing visitors consented to changed, so nobody is asked again." }),
  };
}

/** Remove a tag. Only narrows what runs, so nobody is asked again. */
export async function removeTag(ctx: unknown, args: unknown) {
  const parsed = z.object({ name: tagName }).strict().safeParse(args);
  if (!parsed.success) throw new Error(describeIssues("remove_tag", parsed.error));
  const { name } = parsed.data;
  const q = adminQueryOf(ctx);
  const rows = (await q.list("tags", { name, limit: 1 })) as unknown as TagRow[];
  const row = rows[0];
  if (!row) throw new Error(`remove_tag: no tag named "${name}" — list_tracking_tags shows them`);
  await q.delete("tags", row.id);
  await touchDeclaration(q);
  return { removed: name };
}

/** The tags with everything the AI needs to explain or change them, plus the vendor templates. */
export async function listTags(ctx: unknown) {
  const tags = await allTags(ctx);
  const unknown = await unknownScopeIds(
    cmsOf(ctx),
    tags.map((t) => t.scope ?? {}),
  );
  return {
    tags: tags.map((t) => {
      const ids = scopeIds(t.scope ?? {});
      const stale = [
        ...ids.pages.filter((id) => unknown.pages.has(id)).map((id) => `page ${id}`),
        ...ids.templates.filter((id) => unknown.templates.has(id)).map((id) => `template ${id}`),
      ];
      return {
        id: t.id,
        name: t.name,
        vendor: t.vendor,
        category: t.category_key,
        config: t.config ?? {},
        loads: t.script_src || "(inline snippet)",
        position: t.position,
        enabled: t.enabled,
        justification: t.justification,
        cookies: (t.cookies ?? []).map((c) => ({ ...c, label: cookieLabel(c) })),
        vendorInfo: t.vendor_info ?? {},
        scope: t.scope ?? {},
        declarationGaps: declarationGaps({
          vendor: t.vendor,
          cookies: t.cookies ?? [],
          vendor_info: t.vendor_info ?? {},
        }),
        // A page or template deleted since: the tag no longer runs there.
        ...(stale.length > 0 ? { scopeNoLongerExists: stale } : {}),
      };
    }),
    knownVendors: Object.entries(VENDOR_TEMPLATES).map(([key, v]) => ({
      vendor: key,
      category: v.category,
      note: v.note,
      config: Object.fromEntries(Object.entries(v.config).map(([k, f]) => [k, f.format])),
      cookies: v.cookies.map(cookieLabel),
    })),
  };
}

/**
 * The enabled tags as the runtime carries them, scopes resolved to
 * paths. A page or template deleted since the tag was scoped to it has
 * no path any more, so it contributes nothing — the tag runs on fewer
 * pages, never on more; `list_tags` reports the stale ids.
 */
export async function bakeTags(ctx: unknown): Promise<BakedTag[]> {
  const tags = (await allTags(ctx)).filter((t) => t.enabled);
  const needsPages = tags.some((t) => {
    const ids = scopeIds(t.scope ?? {});
    return ids.pages.length > 0 || ids.templates.length > 0;
  });
  const pages = needsPages ? await pagesOf(cmsOf(ctx)) : [];
  const pathOf = new Map(pages.map((p) => [p.id, p.currentPath]));
  const pathsOfTemplate = (id: string) =>
    pages.filter((p) => p.templateId === id).map((p) => p.currentPath);
  const resolve = (paths?: string[], pageIds?: string[], templateIds?: string[]) => [
    ...(paths ?? []),
    ...(pageIds ?? []).flatMap((id) => {
      const path = pathOf.get(id);
      return path ? [path] : [];
    }),
    ...(templateIds ?? []).flatMap(pathsOfTemplate),
  ];
  return tags.map((t) => {
    const s = t.scope ?? {};
    const scoped = (s.paths?.length ?? 0) + (s.pageIds?.length ?? 0) + (s.templateIds?.length ?? 0);
    return {
      name: t.name,
      category: t.category_key,
      src: t.script_src,
      inline: t.inline_snippet,
      position: t.position === "head" ? "head" : "body_end",
      cookies: (t.cookies ?? []).map((c) => ({ name: c.name, prefix: c.pattern === true })),
      scope: {
        include: scoped > 0 ? resolve(s.paths, s.pageIds, s.templateIds) : null,
        exclude: resolve(s.excludePaths, s.excludePageIds, s.excludeTemplateIds),
        locales: s.locales && s.locales.length > 0 ? s.locales : null,
      },
    };
  });
}
