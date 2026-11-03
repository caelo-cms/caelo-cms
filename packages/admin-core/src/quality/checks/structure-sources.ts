// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #820 — the structure check's sources, read through the Query API
 * (`modules.list`, `layouts.list`; #1256 adds `pages.list`,
 * `page_types.list` and `site_defaults.get`) as the audit worker's system actor. A
 * system actor carries no chat branch, so it reads main — the state the
 * staged build was rendered from.
 *
 * A failed read throws: the runner then reports the check as failed and
 * the audit fails loudly (runner.ts), instead of reading as "no findings".
 */

import { hasLinkResolveContributors, resolveLinkVariants } from "@caelo-cms/plugin-host";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "../../ai/tools/_describe-error.js";
import { siteHostsOf } from "./links-analysis.js";
import type { StructureLayout, StructureSources } from "./structure.js";
import type { StructureModule } from "./structure-analysis.js";
import type { StructurePageIndex } from "./structure-listing.js";

/** `list_types.list` as the entry keys need it. */
interface ListTypeRows {
  readonly listTypes: readonly {
    readonly slug: string;
    readonly definition: {
      readonly nodes: Readonly<
        Record<
          string,
          {
            fields: readonly { name: string; type?: string; options?: readonly string[] }[];
            children?: { name: string };
          }
        >
      >;
    };
  }[];
}

/**
 * List type slug -> the keys its entries carry: node field names, the
 * `<select>_<option>` flags of select fields, and children loop names.
 */
function entryKeysByType(rows: ListTypeRows): Map<string, string[]> {
  return new Map(
    rows.listTypes.map((t) => [
      t.slug,
      Object.values(t.definition.nodes).flatMap((n) => [
        ...n.fields.flatMap((f) => [
          f.name,
          ...(f.type === "select" ? (f.options ?? []).map((o) => `${f.name}_${o}`) : []),
        ]),
        ...(n.children ? [n.children.name] : []),
      ]),
    ]),
  );
}

/** The `kind`s of fields whose sections render entries (#1256). */
const LIST_KINDS = new Set(["list", "module-list"]);

/** Sources backed by the Query API. */
export function structureSourcesFromOps(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
): StructureSources {
  const read = async <T>(
    op: string,
    pick: (value: unknown) => T,
    input: Record<string, unknown> = { includeDeleted: false },
  ): Promise<T> => {
    const r = await execute(registry, adapter, ctx, op, input);
    if (!r.ok) throw new Error(`${op} failed: ${describeError(r.error)}`);
    return pick(r.value);
  };
  return {
    modules: async () => {
      const [rows, entryKeysOf] = await Promise.all([
        read(
          "modules.list",
          (v) =>
            (
              v as {
                modules: (Omit<
                  StructureModule,
                  | "listFields"
                  | "moduleListFields"
                  | "fieldNames"
                  | "entryKeys"
                  | "defaultModuleIds"
                > & {
                  fields: { name: string; kind: string; listType?: string; default?: unknown }[];
                })[];
              }
            ).modules,
        ),
        read("list_types.list", (v) => entryKeysByType(v as ListTypeRows), {}),
      ]);
      return rows.map((m) => ({
        id: m.id,
        slug: m.slug,
        displayName: m.displayName,
        html: m.html,
        js: m.js,
        css: m.css,
        kind: m.kind,
        listFields: m.fields.filter((f) => LIST_KINDS.has(f.kind)).map((f) => f.name),
        moduleListFields: m.fields.filter((f) => f.kind === "module-list").map((f) => f.name),
        fieldNames: m.fields.map((f) => f.name),
        defaultModuleIds: embeddedModuleIds(m.fields.map((f) => f.default)),
        entryKeys: Object.fromEntries(
          m.fields.flatMap((f) =>
            f.kind === "list" && f.listType ? [[f.name, entryKeysOf.get(f.listType) ?? []]] : [],
          ),
        ),
      }));
    },
    layouts: () =>
      read("layouts.list", (v) =>
        (
          v as {
            layouts: (Omit<StructureLayout, "chromeModuleSlugs"> & {
              blocks: { moduleSlugs: string[] }[];
            })[];
          }
        ).layouts.map((l) => ({
          id: l.id,
          displayName: l.displayName,
          html: l.html,
          css: l.css,
          chromeModuleSlugs: l.blocks.flatMap((b) => b.moduleSlugs),
        })),
      ),
    pageIndex: async (): Promise<StructurePageIndex> => {
      const [types, pages, templates, siteUrls] = await Promise.all([
        read(
          "page_types.list",
          (v) =>
            (
              v as {
                pageTypes: {
                  id: string;
                  slug: string;
                  name: string;
                  purpose: string;
                  collection: boolean;
                }[];
              }
            ).pageTypes,
          {},
        ),
        read(
          "pages.list",
          (v) =>
            (
              v as {
                pages: {
                  id: string;
                  pageTypeId: string;
                  pageTypeConfirmed: boolean;
                  title: string;
                  currentPath: string;
                  templateId: string;
                }[];
              }
            ).pages,
        ),
        read(
          "templates.list",
          (v) => (v as { templates: { id: string; layoutId: string }[] }).templates,
          // A deleted template still names its layout; a page left on one
          // must not fail the audit over the lookup.
          { includeDeleted: true },
        ),
        readSiteUrls((op, input) => read(op, (v) => v, input)),
      ]);
      return {
        pageTypes: new Map(
          types.map((t) => [
            t.id,
            { slug: t.slug, name: t.name, purpose: t.purpose, collection: t.collection },
          ]),
        ),
        pages: new Map(
          pages.map((p) => [
            p.id,
            {
              pageTypeId: p.pageTypeId,
              pageTypeConfirmed: p.pageTypeConfirmed,
              title: p.title,
              path: p.currentPath,
            },
          ]),
        ),
        siteHosts: siteHostsOf(siteUrls),
        pageLayouts: pageLayoutsOf(pages, templates),
        variantGroups: await readVariantGroups(
          pages.map((p) => p.id),
          ctx.chatBranchId ?? null,
        ),
      };
    },
  };
}

/**
 * #1371 — the module ids a set of field defaults embeds: every object
 * with a string `moduleId` (a `module` / `module-list` value), at any
 * depth (a list entry's `module` field included).
 */
export function embeddedModuleIds(values: readonly unknown[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v !== null && typeof v === "object") {
      const id = (v as { moduleId?: unknown }).moduleId;
      if (typeof id === "string") out.add(id);
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(values);
  return [...out];
}

/**
 * #1371 — page id → the layout its template binds. A page whose template
 * is not listed is a broken reference the build would already have
 * refused; it throws here rather than reading as "no layout" (CLAUDE.md §2).
 */
function pageLayoutsOf(
  pages: readonly { id: string; templateId: string }[],
  templates: readonly { id: string; layoutId: string }[],
): Map<string, string> {
  const layoutOf = new Map(templates.map((t) => [t.id, t.layoutId]));
  return new Map(
    pages.map((p) => {
      const layoutId = layoutOf.get(p.templateId);
      if (layoutId === undefined)
        throw new Error(
          `structure sources: page ${p.id} binds template ${p.templateId}, which templates.list does not return`,
        );
      return [p.id, layoutId];
    }),
  );
}

/**
 * #1305 — the variant groups of the link-resolve composition point (the
 * same partition every render resolves page links with): page id → its
 * group, for pages a plugin places in one. No plugin call without an
 * active contributor.
 */
async function readVariantGroups(
  pageIds: readonly string[],
  chatBranchId: string | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (pageIds.length === 0 || !hasLinkResolveContributors()) return out;
  for (const [pageId, v] of await resolveLinkVariants(pageIds, { chatBranchId })) {
    if (v.group !== null) out.set(pageId, v.group);
  }
  return out;
}

/**
 * The URLs the public site answers on: the SEO base URL and the public
 * domains (#849; #1256 reuses it so a card linking the public domain is a
 * link to the site, not an external one).
 */
export async function readSiteUrls(
  run: (op: string, input: Record<string, unknown>) => Promise<unknown>,
): Promise<string[]> {
  const [seo, domains] = (await Promise.all([
    run("site_defaults.get_seo", {}),
    run("domains.list", {}),
  ])) as [
    { siteBaseUrl: string | null },
    { domains: { hostname: string; kind: "admin" | "public" }[] },
  ];
  return [
    ...(seo.siteBaseUrl ? [seo.siteBaseUrl] : []),
    // The admin domain is not the site: a link there is not a page of it.
    ...domains.domains.filter((d) => d.kind === "public").map((d) => d.hostname),
  ];
}
