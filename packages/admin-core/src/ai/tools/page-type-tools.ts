// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — page type tools (docs/lists.md §5, §12). A page type says
 * what a page IS (News article, Product, Doc): its properties, the
 * vocabularies (categories, tags) its pages are assigned to, and the
 * templates it may use. `list_page_types` covers `page_types.list` and,
 * with `slug`, `page_types.get` (sample pages).
 *
 * Why a delete tool although docs §12 listed none: CLAUDE.md §11 parity —
 * the AI creates page types, so it must be able to remove one it created
 * by mistake (the op refuses while pages use the type, and the site's
 * default type), and the operator should not need the panel for it.
 */

import { execute } from "@caelo-cms/query-api";
import type { FieldDef, PageTypeDef } from "@caelo-cms/shared";
import { z } from "zod";
import { deletePageTypesManyOp, upsertPageTypesManyOp } from "../../ops/lists/page-types.js";
import { describeError } from "./_describe-error.js";
import { makeOpTool, toolNamesIn } from "./_list-tool-kit.js";
import { UPSERT_PAGE_TYPES_JSON_SCHEMA } from "./_list-tool-schemas.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listPageTypesInput = z
  .object({
    slug: z.string().min(1).max(64).optional().describe("One type in detail, with sample pages."),
    query: z.string().min(1).max(128).optional().describe("Free text over slug, name, purpose."),
  })
  .strict();
type ListPageTypesInput = z.infer<typeof listPageTypesInput>;

interface PageTypeRow extends PageTypeDef {
  id: string;
  version: number;
  pageCount: number;
  vocabularySlugs: string[];
}

function describeProperty(f: FieldDef): string {
  return `${f.name}${f.required ? "*" : ""}:${f.type}`;
}

function describePageType(t: PageTypeRow): string {
  const vocab = t.vocabularies
    .map(
      (v, i) =>
        `${t.vocabularySlugs[i] ?? v.list} (${v.cardinality}${v.required ? ", required" : ""}, list ${v.list})`,
    )
    .join("; ");
  return [
    `${t.slug} — ${t.name}: ${t.purpose}`,
    `  id ${t.id}; ${t.pageCount} page(s); version ${t.version}`,
    `  templates: ${t.templates.join(", ")} (default ${t.defaultTemplate})`,
    `  properties: ${t.properties.map(describeProperty).join(", ") || "none"}`,
    `  vocabularies: ${vocab || "none"}`,
  ].join("\n");
}

export const listPageTypesTool: ToolDefinitionWithHandler<ListPageTypesInput> = {
  name: "list_page_types",
  description:
    "The site's page types, what each page IS (`content`, `news`, `product`): purpose, page count, allowed + default template ids, properties (`*` = required), vocabularies (categories/tags lists whose terms its pages carry). " +
    'Read before `build_page` / `update_pages_many` (a new article gets `pageType:"news"` + its properties and terms) and before a page query (`page_type` filters on the slug). New KIND of content (blog, job board) -> `upsert_page_types_many`.',
  schema: listPageTypesInput,
  handler: async (ctx, input, toolCtx) => {
    if (input.slug !== undefined) {
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "page_types.get", {
        slug: input.slug,
      });
      if (!r.ok) {
        return { ok: false, content: `list_page_types: ${toolNamesIn(describeError(r.error))}` };
      }
      const v = r.value as {
        pageType: PageTypeRow;
        samplePages: { path: string; title: string }[];
      };
      return {
        ok: true,
        content: `${describePageType(v.pageType)}\n  sample pages: ${v.samplePages.map((p) => `${p.path} ("${p.title}")`).join(", ") || "none"}`,
        value: r.value,
      };
    }
    const { slug: _slug, ...filters } = input;
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "page_types.list", filters);
    if (!r.ok) {
      return { ok: false, content: `list_page_types: ${toolNamesIn(describeError(r.error))}` };
    }
    const rows = (r.value as { pageTypes: PageTypeRow[] }).pageTypes;
    return {
      ok: true,
      content:
        rows.length === 0
          ? "No page type matches. Create one with upsert_page_types_many."
          : rows.map(describePageType).join("\n"),
      value: r.value,
    };
  },
};

export const upsertPageTypesManyTool = makeOpTool({
  name: "upsert_page_types_many",
  description:
    "Create or replace page types in one transaction, when the operator starts a new kind of content ('a news section with categories', 'a job board').\n" +
    "CORE RULES:\n" +
    "- `templates`: ids from `list_templates`; none fits -> `create_template` WITHOUT `pageType` first, then list its id here. `defaultTemplate` is one of them.\n" +
    "- `properties`: fields every page of the type carries (e.g. `author` text, `event_date` date); no `module` fields. `vocabularies[].list`: list id from `list_lists`.\n" +
    "- Order for 'news with categories': `upsert_lists_many` (a `categories` list) -> `create_template` (no pageType) or reuse one -> this, with the template id -> `build_page`/`update_pages_many` with pageType, properties, terms.\n" +
    "- Type in use: a new property's default is written into its pages; dropping a template they use is refused (move them first); dropping a property/vocabulary they hold values for needs `dropValues:true` (only with operator agreement). Pass `expectedVersion` from `list_page_types`.",
  inputSchema: UPSERT_PAGE_TYPES_JSON_SCHEMA,
  opName: "page_types.upsert_many",
  input: upsertPageTypesManyOp.input,
  format: (value) =>
    (
      value as {
        pageTypes: {
          id: string;
          slug: string;
          version: number;
          created: boolean;
          pagesRewritten: number;
        }[];
      }
    ).pageTypes
      .map(
        (t) =>
          `page type ${t.slug} ${t.created ? "created" : "updated"}: id=${t.id} version ${t.version}${t.pagesRewritten ? `, ${t.pagesRewritten} page(s) adapted` : ""}`,
      )
      .join("\n"),
});

export const deletePageTypesManyTool = makeOpTool({
  name: "delete_page_types_many",
  description:
    "Delete page types by slug. Refused for the site's default type and while pages use it (move them first: `update_pages_many` `pageType`). Undoable.",
  opName: "page_types.delete_many",
  input: deletePageTypesManyOp.input,
  format: (value) =>
    `deleted page type(s): ${(value as { deleted: string[] }).deleted.join(", ") || "none"}`,
});
