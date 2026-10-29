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
        Record<string, { fields: readonly { name: string }[]; children?: { name: string } }>
      >;
    };
  }[];
}

/** List type slug -> the keys its entries carry: node field names and children loop names. */
function entryKeysByType(rows: ListTypeRows): Map<string, string[]> {
  return new Map(
    rows.listTypes.map((t) => [
      t.slug,
      Object.values(t.definition.nodes).flatMap((n) => [
        ...n.fields.map((f) => f.name),
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
                modules: (Omit<StructureModule, "listFields" | "fieldNames" | "entryKeys"> & {
                  fields: { name: string; kind: string; listType?: string }[];
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
        listFields: m.fields.filter((f) => LIST_KINDS.has(f.kind)).map((f) => f.name),
        fieldNames: m.fields.map((f) => f.name),
        entryKeys: [
          ...new Set(
            m.fields.flatMap((f) =>
              f.kind === "list" && f.listType ? (entryKeysOf.get(f.listType) ?? []) : [],
            ),
          ),
        ],
      }));
    },
    layouts: () =>
      read("layouts.list", (v) =>
        (v as { layouts: StructureLayout[] }).layouts.map((l) => ({
          id: l.id,
          displayName: l.displayName,
          html: l.html,
          css: l.css,
        })),
      ),
    pageIndex: async (): Promise<StructurePageIndex> => {
      const [defaults, types, pages, siteUrls] = await Promise.all([
        read(
          "site_defaults.get",
          (v) => (v as { defaults: { defaultPageTypeId: string } | null }).defaults,
          {},
        ),
        read(
          "page_types.list",
          (v) => (v as { pageTypes: { id: string; slug: string; name: string }[] }).pageTypes,
          {},
        ),
        read(
          "pages.list",
          (v) => (v as { pages: { id: string; pageTypeId: string; title: string }[] }).pages,
        ),
        readSiteUrls((op, input) => read(op, (v) => v, input)),
      ]);
      // No fallback (CLAUDE.md §2): without the stored default the rule
      // cannot tell ordinary pages from typed ones.
      if (defaults === null) {
        throw new Error(
          "site_defaults.get returned no site defaults — the structure check needs default_page_type_id",
        );
      }
      return {
        defaultPageTypeId: defaults.defaultPageTypeId,
        pageTypes: new Map(types.map((t) => [t.id, { slug: t.slug, name: t.name }])),
        pages: new Map(pages.map((p) => [p.id, { pageTypeId: p.pageTypeId, title: p.title }])),
        siteHosts: siteHostsOf(siteUrls),
      };
    },
  };
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
