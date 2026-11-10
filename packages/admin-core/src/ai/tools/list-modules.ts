// SPDX-License-Identifier: MPL-2.0

/**
 * issue #159 — `list_modules`. AI-callable wrapper around `modules.list`
 * + `modules.list_usage`.
 *
 * The module catalog the AI picks from: the read surface CLAUDE.md §11
 * mandates (the system prompt is static, so there is no catalog block).
 * Carries the full decision-support metadata (description, kind, type,
 * fields, usage) on demand, filterable so the result stays scannable.
 * #1090 / #1093 — a nested field's `allowedModuleTypes` is part of the
 * fields column: it is what the AI must know before it picks a child
 * module, and it was visible nowhere before the call was refused.
 *
 * Deliberately returns metadata only — never html/css/js. Reading a
 * module's body is an editing concern (`read_content` / `edit_content` handle it);
 * dumping bodies here would blow the context for zero decision value.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import {
  isUnplaced,
  MAX_USAGE_MODULES,
  type ModuleUsage,
} from "../../ops/content/module-placements.js";
import { describeError, toolError } from "./_describe-error.js";
import { LIST_DEFAULT_LIMIT, listParamsSchema, renderToonList } from "./_list-read-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listModulesInput = z
  .object({
    /** Restrict to one catalog kind. */
    kind: z.enum(["chrome", "hero", "content", "cta", "utility"]).optional(),
  })
  // Uniform list surface: filter (substring), limit/offset, full.
  .extend(listParamsSchema.shape)
  .strict();
type ListModulesInput = z.infer<typeof listModulesInput>;

interface ModuleMeta {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  kind: "chrome" | "hero" | "content" | "cta" | "utility";
  type?: string;
  fields: CatalogFieldMeta[];
}

/** The parts of a module field the catalog shows. */
interface CatalogFieldMeta {
  name: string;
  kind: string;
  allowedModuleTypes?: string[];
  /** `list` fields (epic #1107): the type, binding, fixed list and source. */
  listType?: string;
  bind?: "local" | "shared" | "source";
  list?: string;
  source?: { kind: string; name?: string; defaults?: Record<string, unknown> };
  /** #1257 — a paginated overview list. */
  paginate?: { per_page?: number; follow_ups?: string };
}

/** `caelo:list/<id>` → `<slug>` for the catalog; the ref itself when the list is unknown. */
export type ListSlugLookup = (ref: string) => string;

/**
 * One field as the catalog shows it: `name:kind`; for a nested field the
 * module types it accepts (`blocks:module-list allowed=faq/cta`, or
 * `allowed=any`); for a list field its type and binding
 * (`nav:list(menu) shared=main-nav`, `items:list(texts) local`,
 * `news:list(links) source=query(page_type=news)`).
 */
export function catalogField(f: CatalogFieldMeta, listSlug: ListSlugLookup = (ref) => ref): string {
  if (f.kind === "list") {
    const bind = f.bind ?? "local";
    const head = `${f.name}:list(${f.listType ?? "?"})`;
    if (bind === "shared") return `${head} shared=${f.list ? listSlug(f.list) : "per-placement"}`;
    if (bind === "source" && f.source) {
      const s = f.source;
      const what =
        s.kind === "query"
          ? `query(${Object.entries(s.defaults ?? {})
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(" ")})`
          : `${s.kind}:${s.name ?? "?"}`;
      // #1257 — the AI sees an overview's page size and indexing (§1A).
      const paged = f.paginate
        ? ` paginate(per_page=${f.paginate.per_page ?? 50} follow_ups=${f.paginate.follow_ups ?? "index"})`
        : "";
      return `${head} source=${what}${paged}`;
    }
    return `${head} ${bind}`;
  }
  if (f.kind !== "module" && f.kind !== "module-list") return `${f.name}:${f.kind}`;
  const allowed =
    f.allowedModuleTypes && f.allowedModuleTypes.length > 0
      ? f.allowedModuleTypes.join("/")
      : "any";
  return `${f.name}:${f.kind} allowed=${allowed}`;
}

/**
 * The `placements` cell: `unplaced` is what the delete guard concludes, so
 * pages, layouts and parent modules all count. Rows past the shown page are
 * rendered too and dropped by `renderToonList`.
 */
function placementsCell(u: ModuleUsage | undefined): string {
  if (isUnplaced(u) || u === undefined) return "unplaced";
  const parts: string[] = [];
  if (u.placementCount > 0) {
    const samples = u.samplePaths.join("|");
    parts.push(
      `${u.placementCount}${u.placementCountCapped ? "+" : ""}${samples ? ` (${samples})` : ""}`,
    );
  }
  if (u.layouts.length > 0) parts.push(`layout ${u.layouts.join("|")}`);
  if (u.nestedIn.length > 0) parts.push(`nested in ${u.nestedIn.join("|")}`);
  return parts.join(" + ");
}

export const listModulesTool: ToolDefinitionWithHandler<ListModulesInput> = {
  name: "list_modules",
  description:
    "List the module catalog (metadata, no HTML/CSS/JS): id, slug, type, kind, description, fields, placements as this chat sees the site (`unplaced` = no page, layout or parent module).\n" +
    "USE FOR: a reuse candidate before placing/creating (prefer `add_module` with `moduleId` over a near-duplicate); the accepted child types before filling a `module`/`module-list` field.\n" +
    "Fields column: `blocks:module-list allowed=faq/cta` -> child `type` must be one of them (`allowed=any` = unrestricted). " +
    "`nav:list(menu) shared=main-nav` = shared list (edit entries via `patch_list_items_many`) | `items:list(texts) local` = entries per placement | `latest:list(links) source=query(…)` | `… paginate(per_page=50 follow_ups=index)` = overview of every match over follow-up pages.",
  schema: listModulesInput,
  inputSchema: z.toJSONSchema(listModulesInput) as Record<string, unknown>,
  handler: async (ctx, input, toolCtx) => {
    const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.list", {
      includeDeleted: false,
    });
    if (!listed.ok) {
      return toolError(listed.error, `modules.list failed: ${describeError(listed.error)}`);
    }
    const all = (listed.value as { modules: (ModuleMeta & Record<string, unknown>)[] }).modules;
    // Shared list fields name a list by reference; show its slug, which is
    // what list_lists / get_list / patch_list_items_many take.
    let listSlug: ListSlugLookup = (ref) => ref;
    if (all.some((m) => m.fields.some((f) => f.kind === "list" && f.list !== undefined))) {
      const lists = await execute(toolCtx.registry, toolCtx.adapter, ctx, "lists.list", {});
      if (lists.ok) {
        const slugs = new Map(
          (lists.value as { lists: { id: string; slug: string }[] }).lists.map((l) => [
            `caelo:list/${l.id}`,
            l.slug,
          ]),
        );
        listSlug = (ref) => slugs.get(ref) ?? ref;
      }
    }
    const needle = input.filter?.toLowerCase();
    const matches = all.filter((m) => {
      if (input.kind !== undefined && m.kind !== input.kind) return false;
      if (needle === undefined) return true;
      return [m.slug, m.displayName, m.description, m.type ?? ""].some((s) =>
        s.toLowerCase().includes(needle),
      );
    });

    // Usage of the rows this call shows: a catalog read costs its page,
    // however many modules the site has or pages place them.
    const offset = input.offset ?? 0;
    const shown = input.full
      ? matches.slice(offset)
      : matches.slice(offset, offset + (input.limit ?? LIST_DEFAULT_LIMIT));
    const usage = new Map<string, ModuleUsage>();
    for (let i = 0; i < shown.length; i += MAX_USAGE_MODULES) {
      const usageRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.list_usage", {
        moduleIds: shown.slice(i, i + MAX_USAGE_MODULES).map((m) => m.id),
      });
      if (!usageRes.ok) {
        return toolError(
          usageRes.error,
          `modules.list_usage failed: ${describeError(usageRes.error)}`,
        );
      }
      for (const u of (usageRes.value as { usage: ModuleUsage[] }).usage) usage.set(u.moduleId, u);
    }

    if (matches.length === 0) {
      const filterNote =
        input.kind !== undefined || input.filter !== undefined
          ? ` matching ${[
              input.kind !== undefined ? `kind=${input.kind}` : "",
              input.filter !== undefined ? `filter=${JSON.stringify(input.filter)}` : "",
            ]
              .filter(Boolean)
              .join(" ")} (catalog has ${all.length} total — retry without the filter?)`
          : " — mint one via add_module / build_page";
      return { ok: true, content: `0 modules${filterNote}.` };
    }

    const toon = renderToonList(
      "modules",
      matches,
      [
        { key: "slug", value: (m) => m.slug },
        { key: "id", value: (m) => m.id },
        { key: "type", value: (m) => m.type ?? "" },
        { key: "kind", value: (m) => m.kind },
        { key: "displayName", value: (m) => m.displayName },
        {
          key: "description",
          value: (m) => (m.description.trim() === "" ? "(no description)" : m.description.trim()),
        },
        {
          key: "fields",
          value: (m) => m.fields.map((f) => catalogField(f, listSlug)).join("|"),
        },
        {
          key: "placements",
          value: (m) => placementsCell(usage.get(m.id)),
        },
      ],
      // The metadata pre-filter above already applied `filter`; don't
      // re-filter TOON lines (ids would rarely match a prose filter).
      { limit: input.limit, offset: input.offset, full: input.full },
    );
    // Metadata-only payload for programmatic follow-ups (retry paths,
    // future manifest tooling) — bodies stay out by design.
    const value = {
      modules: shown.map((m) => ({
        id: m.id,
        slug: m.slug,
        displayName: m.displayName,
        description: m.description,
        kind: m.kind,
        ...(m.type !== undefined ? { type: m.type } : {}),
        fields: m.fields.map((f) => ({
          name: f.name,
          kind: f.kind,
          ...(f.allowedModuleTypes ? { allowedModuleTypes: f.allowedModuleTypes } : {}),
          ...(f.kind === "list"
            ? {
                listType: f.listType,
                bind: f.bind ?? "local",
                ...(f.list !== undefined ? { list: f.list } : {}),
                ...(f.source !== undefined ? { source: f.source } : {}),
                ...(f.paginate !== undefined ? { paginate: f.paginate } : {}),
              }
            : {}),
        })),
        usage: usage.get(m.id),
      })),
    };
    return {
      ok: true,
      content: `${matches.length} of ${all.length} modules:
${toon}`,
      value,
    };
  },
};
