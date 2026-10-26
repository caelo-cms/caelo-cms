// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — `lists.preview_source` (docs/lists.md §6, §12): what a page
 * query, a system source or a plugin source returns for one page, BEFORE
 * the AI binds it to a module or saves it in a list.
 *
 * Why an op and not "render the page and look": "show the three latest
 * news in the menu" is decided by the query's filter (page type, terms,
 * order, limit), and a wrong filter renders an empty block that reads as
 * fine. The AI checks the entries here, in the caller's draft view, with
 * the exact resolver every render uses (`createListRenderContext` over
 * `loadListRenderData`), so preview, build and this answer cannot
 * disagree.
 *
 * Three ways to name the source, exactly one per call:
 *  - `source` (+ `value`, `vocabulary`): a source definition as a module
 *    field would declare it, with the placement's overrides;
 *  - `list` + `itemId`: a source node stored in a shared list (a mega
 *    menu's "latest news" column) with its saved query;
 *  - `list` + `node` (+ `value`): a source node KIND of the list's type
 *    with the knobs an entry would set — what the list editor previews
 *    while the operator edits an entry's query, before saving it;
 *  - `moduleId` + `field` (+ `contentInstanceId`): a module's `bind:
 *    "source"` field, with that placement's overrides.
 */

import { dormantDataListNames, resolveDataLists } from "@caelo-cms/plugin-host";
import { defineOperation } from "@caelo-cms/query-api";
import {
  createListRenderContext,
  type ListFieldSpec,
  ok,
  type PluginSourceEntry,
  pageQueryPartialSchema,
  pluginSourcesFromDataLists,
  type ScopeEntry,
  type ScopeValue,
  sourceDefSchema,
} from "@caelo-cms/shared";
import { z } from "zod";
import { withHumanisedLinks } from "../../links/humanise.js";
import { loadListRenderData } from "../../lists/load.js";
import {
  bindingOf,
  listFieldsOf,
  loadInstancesOfModules,
  loadModulesInView,
} from "../../lists/local.js";
import { loadListEntities, loadListEntityBySlug } from "../../lists/store.js";
import { loadPublishPageUrlStyle } from "../content/public-urls.js";
import { branchOf, handlerError } from "./_shared.js";

const OP = "lists.preview_source";

/** Keys a generated entry is shown with (page-shaped, term-shaped and plugin entries). */
const ENTRY_KEYS = [
  "title",
  "name",
  "label",
  "slug",
  "link",
  "published_at",
  "updated_at",
  "page_type",
  "summary",
  "is_current",
] as const;

const entrySchema = z.object({ id: z.string() }).catchall(z.unknown());

const inputSchema = z
  .object({
    /** The page the entries are generated for; omit for a render outside any page. */
    pageId: z.string().uuid().optional(),
    source: sourceDefSchema.optional(),
    /** With `source`: the placement's overrides (query knobs, or `{terms}` for term_pages). */
    value: z.record(z.string(), z.unknown()).optional(),
    /** With a `page_terms` source: the vocabulary (`caelo:list/<id>`). */
    vocabulary: z.string().optional(),
    /** A shared list (slug) holding the source node … */
    list: z.string().min(1).max(64).optional(),
    /** … and the id of that node (its saved query) … */
    itemId: z.string().uuid().optional(),
    /** … or a source node kind of the list's type, with `value` as the entry's knobs. */
    node: z.string().min(1).max(64).optional(),
    /** A module whose `bind: "source"` list field to preview … */
    moduleId: z.string().uuid().optional(),
    field: z.string().min(1).max(64).optional(),
    /** … with this placement's overrides (its content instance). */
    contentInstanceId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const modes = [
      v.source !== undefined,
      v.list !== undefined || v.itemId !== undefined || v.node !== undefined,
      v.moduleId !== undefined || v.field !== undefined,
    ].filter(Boolean).length;
    if (modes !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "name the source exactly one way: `source` (a source definition), `list` + `itemId` (a source node of a shared list), `list` + `node` (a source node kind of the list's type) or `moduleId` + `field` (a module's source field)",
      });
    }
    if (v.list !== undefined && (v.itemId === undefined) === (v.node === undefined)) {
      ctx.addIssue({ code: "custom", message: "`list` takes exactly one of `itemId`, `node`" });
    }
    if (v.list === undefined && (v.itemId !== undefined || v.node !== undefined)) {
      ctx.addIssue({ code: "custom", message: "`itemId` / `node` go with `list`" });
    }
    if ((v.moduleId === undefined) !== (v.field === undefined)) {
      ctx.addIssue({ code: "custom", message: "`moduleId` and `field` go together" });
    }
    if (v.vocabulary !== undefined && v.source === undefined) {
      ctx.addIssue({ code: "custom", message: "`vocabulary` goes with `source` only" });
    }
    if (v.value !== undefined && v.source === undefined && v.node === undefined) {
      ctx.addIssue({ code: "custom", message: "`value` goes with `source` or `list` + `node`" });
    }
  });

type Input = z.infer<typeof inputSchema>;

/** A scope value as JSON: text as text, flags as booleans, records by their bare text. */
function jsonOf(v: ScopeValue | undefined): unknown {
  if (v === undefined) return undefined;
  switch (v.kind) {
    case "text":
      return v.text === "" ? undefined : v.text;
    case "bool":
      return v.value;
    case "record":
      return v.text ?? undefined;
    case "list":
      return v.entries.length;
    case "module":
      return `module ${v.ref.moduleId}`;
    case "failed":
      return v.marker;
  }
}

function entryJson(e: ScopeEntry): z.infer<typeof entrySchema> {
  const out: Record<string, unknown> = { id: e.id };
  for (const key of ENTRY_KEYS) {
    const v = jsonOf(e.get(key));
    if (v !== undefined) out[key] = v;
  }
  return out as z.infer<typeof entrySchema>;
}

/** The field spec + placement value + description the resolver is asked with, or an error message. */
async function specFor(
  tx: Parameters<typeof previewListSourceOp.handler>[2],
  branchId: string | null,
  input: Input,
): Promise<
  | {
      ok: true;
      spec: ListFieldSpec;
      value: unknown;
      /** For a source node: the node's id inside the resolved shared list. */
      itemId?: string;
      describe: string;
    }
  | { ok: false; message: string }
> {
  if (input.source !== undefined) {
    return {
      ok: true,
      spec: {
        name: "preview",
        listType: "preview",
        bind: "source",
        source: input.source,
        ...(input.vocabulary !== undefined ? { list: input.vocabulary } : {}),
      },
      value: input.value,
      describe: `${input.source.kind} source`,
    };
  }
  if (input.list !== undefined) {
    const list = await loadListEntityBySlug(tx, "list", branchId, input.list);
    if (!list || list.state.deletedAt !== null) {
      return {
        ok: false,
        message: `no list "${input.list}" — list_lists shows the site's lists.`,
      };
    }
    // The type slug is all the resolver needs; it reads the definition itself.
    const types = await loadListEntities(tx, "listType", branchId);
    const typeSlug = types.find((t) => t.id === list.state.listTypeId)?.state.slug;
    if (typeSlug === undefined) {
      return { ok: false, message: `list "${input.list}" has no list type in this view.` };
    }
    if (input.node !== undefined) {
      // A node kind previews like a source field: the node's source with
      // the knobs an entry of that kind would store.
      const def = types.find((t) => t.id === list.state.listTypeId)?.state.definition;
      const source = def?.nodes[input.node]?.source;
      if (!source) {
        const kinds = Object.entries(def?.nodes ?? {})
          .filter(([, n]) => n.source !== undefined)
          .map(([k]) => k);
        return {
          ok: false,
          message: `node kind "${input.node}" of list type "${typeSlug}" has no source (source node kinds: ${kinds.join(", ") || "none"}).`,
        };
      }
      return {
        ok: true,
        spec: { name: input.list, listType: typeSlug, bind: "source", source },
        value: input.value,
        describe: `node "${input.node}" of list "${input.list}"`,
      };
    }
    return {
      ok: true,
      spec: {
        name: input.list,
        listType: typeSlug,
        bind: "shared",
        list: `caelo:list/${list.id}`,
      },
      value: undefined,
      itemId: input.itemId,
      describe: `entry ${input.itemId} of list "${input.list}"`,
    };
  }
  const moduleId = input.moduleId as string;
  const module = (await loadModulesInView(tx, branchId)).find((m) => m.id === moduleId);
  if (!module) {
    return { ok: false, message: `no module ${moduleId} — list_modules shows the modules.` };
  }
  const field = listFieldsOf(module.fields).find((f) => f.name === input.field);
  if (!field) {
    const names = listFieldsOf(module.fields).map((f) => f.name);
    return {
      ok: false,
      message: `module "${module.slug}" has no list field "${input.field}" (its list fields: ${names.join(", ") || "none"}).`,
    };
  }
  if (bindingOf(field) !== "source") {
    return {
      ok: false,
      message: `list field "${field.name}" of module "${module.slug}" is bound ${bindingOf(field)}, not to a source — its entries are stored; read them with get_list (shared) or list_modules / get_content_instance (local).`,
    };
  }
  let value: unknown;
  if (input.contentInstanceId !== undefined) {
    const inst = (await loadInstancesOfModules(tx, branchId, [module.id])).find(
      (i) => i.id === input.contentInstanceId,
    );
    if (!inst) {
      return {
        ok: false,
        message: `content instance ${input.contentInstanceId} is not a placement of module "${module.slug}".`,
      };
    }
    value = inst.values[field.name];
  }
  return {
    ok: true,
    spec: field,
    value,
    describe: `field "${field.name}" of module "${module.slug}"`,
  };
}

/** The generated entries of the source node `itemId` among `entries` (depth-first). */
function sourceNodeEntries(
  entries: readonly ScopeEntry[],
  itemId: string,
): { found: false } | { found: true; value: ScopeValue | undefined } {
  for (const e of entries) {
    if (e.id === itemId) return { found: true, value: e.get("items") };
    const kids = e.childrenKey ? e.get(e.childrenKey) : undefined;
    if (kids?.kind === "list") {
      const hit = sourceNodeEntries(kids.entries, itemId);
      if (hit.found) return hit;
    }
  }
  return { found: false };
}

export const previewListSourceOp = withHumanisedLinks(
  defineOperation({
    name: OP,
    actorScope: ["human", "ai", "system"],
    database: "cms_admin",
    input: inputSchema,
    output: z.object({
      source: z.string(),
      count: z.number().int().nonnegative(),
      items: z.array(entrySchema),
    }),
    handler: async (ctx, input, tx) => {
      const branchId = branchOf(ctx);
      if (input.value !== undefined && input.source?.kind === "query") {
        const parsed = pageQueryPartialSchema.safeParse(input.value);
        if (!parsed.success) {
          return {
            ok: false,
            error: handlerError(
              OP,
              `value is not a valid set of query knobs: ${parsed.error.issues.map((i) => i.message).join("; ")}.`,
            ),
          };
        }
      }
      const spec = await specFor(tx, branchId, input);
      if (!spec.ok) return { ok: false, error: handlerError(OP, spec.message) };

      const data = await loadListRenderData(tx, {
        chatBranchId: branchId,
        scope: "preview",
        env: "preview",
      });
      if (input.pageId !== undefined && !data.pages.has(input.pageId)) {
        return {
          ok: false,
          error: handlerError(
            OP,
            `no page ${input.pageId} in this view — list_pages shows the page ids.`,
          ),
        };
      }
      const pageId = input.pageId ?? null;
      // Plugin sources answer per page like in the preview; asked only when
      // the source is a plugin's, so a core preview needs no deploy target.
      let pluginSources: Readonly<Record<string, readonly PluginSourceEntry[]>> = {};
      const nodes = Object.values(data.listTypes.get(spec.spec.listType)?.def.nodes ?? {});
      const isPlugin =
        spec.spec.source?.kind === "plugin" || nodes.some((n) => n.source?.kind === "plugin");
      if (isPlugin && pageId !== null) {
        const style = await loadPublishPageUrlStyle(tx);
        if (style === null) {
          return {
            ok: false,
            error: handlerError(
              OP,
              "no default deploy target — plugin list sources need the page URL style. Mark a deploy target as default under Ops → Deploy.",
            ),
          };
        }
        const resolved = await resolveDataLists([pageId], { chatBranchId: branchId }, style);
        pluginSources = pluginSourcesFromDataLists(resolved.get(pageId) ?? {});
      }
      const page = createListRenderContext(data, {
        dormantPluginSources: dormantDataListNames(),
      }).forPage(pageId, { pluginSources });
      const resolved = page.resolveField(spec.spec, spec.value, { contentInstanceId: null });
      if (!resolved.ok) {
        return {
          ok: false,
          error: handlerError(
            OP,
            `${spec.describe} does not resolve: ${resolved.marker}. Fix the source (list_list_types shows the type's sources; a query's knobs must be in its \`editable\` list).`,
          ),
        };
      }
      let entries: readonly ScopeEntry[] = resolved.entries;
      if (spec.itemId !== undefined) {
        const hit = sourceNodeEntries(resolved.entries, spec.itemId);
        if (!hit.found) {
          return {
            ok: false,
            error: handlerError(
              OP,
              `${spec.describe}: no such entry — get_list shows the entry ids.`,
            ),
          };
        }
        if (hit.value?.kind === "failed") {
          return {
            ok: false,
            error: handlerError(OP, `${spec.describe} does not resolve: ${hit.value.marker}.`),
          };
        }
        entries = hit.value?.kind === "list" ? hit.value.entries : [];
      }
      return ok({
        source: spec.describe,
        count: entries.length,
        items: entries.map(entryJson),
      });
    },
  }),
);
