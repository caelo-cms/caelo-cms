// SPDX-License-Identifier: MPL-2.0

/**
 * issue #159 — `list_modules`. AI-callable wrapper around `modules.list`
 * + `modules.list_usage`.
 *
 * Why it exists: the `## Modules` system-prompt block caps at ~40
 * modules and told the AI to "call `list_modules` for the full set" —
 * but no such tool was registered, so on large catalogs the AI had no
 * escape hatch beyond the truncated block (and burned turns on failed
 * calls). This is the read surface CLAUDE.md §11 mandates: the full
 * decision-support catalog (description, kind, type, fields, usage) on
 * demand, filterable so the result stays scannable.
 *
 * Deliberately returns metadata only — never html/css/js. Reading a
 * module's body is an editing concern (`edit_module` round-trips it);
 * dumping bodies here would blow the context for zero decision value.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import { listParamsSchema, renderToonList } from "./_make-read-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listModulesInput = z
  .object({
    /** Restrict to one catalog kind (the `## Modules` grouping key). */
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
  fields: { name: string; kind: string }[];
}

export const listModulesTool: ToolDefinitionWithHandler<ListModulesInput> = {
  name: "list_modules",
  description:
    "List the FULL module catalog with decision-support metadata: id, slug, type, kind, description, field names, and placement usage. " +
    "Use when the `## Modules` block is truncated (>40 modules), when you need to verify a reuse candidate before minting, or to find modules by `kind`/`filter` (plus `limit`/`offset`/`full` as in every list tool). " +
    "Do NOT call when `## Modules` already shows a fitting module — the block carries the same data. " +
    "Returns metadata only (no HTML/CSS/JS bodies). Prefer placing an existing module (`add_module` with `moduleId`) over minting a near-duplicate.",
  schema: listModulesInput,
  inputSchema: z.toJSONSchema(listModulesInput) as Record<string, unknown>,
  handler: async (ctx, input, toolCtx) => {
    const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.list", {
      includeDeleted: false,
    });
    if (!listed.ok) {
      return { ok: false, content: `modules.list failed: ${describeError(listed.error)}` };
    }
    const usageRes = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "modules.list_usage",
      {},
    );
    if (!usageRes.ok) {
      return { ok: false, content: `modules.list_usage failed: ${describeError(usageRes.error)}` };
    }
    const usage = new Map(
      (
        usageRes.value as {
          usage: { moduleId: string; placementCount: number; sampleSlugs: string[] }[];
        }
      ).usage.map((u) => [u.moduleId, u]),
    );

    const all = (listed.value as { modules: (ModuleMeta & Record<string, unknown>)[] }).modules;
    const needle = input.filter?.toLowerCase();
    const matches = all.filter((m) => {
      if (input.kind !== undefined && m.kind !== input.kind) return false;
      if (needle === undefined) return true;
      return [m.slug, m.displayName, m.description, m.type ?? ""].some((s) =>
        s.toLowerCase().includes(needle),
      );
    });

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
          value: (m) => m.fields.map((f) => `${f.name}:${f.kind}`).join("|"),
        },
        {
          key: "placements",
          value: (m) => {
            const u = usage.get(m.id);
            if (!u || u.placementCount === 0) return "unplaced";
            const samples = u.sampleSlugs
              .slice(0, 3)
              .map((s) => `/${s}`)
              .join("|");
            return `${u.placementCount}${samples ? ` (${samples})` : ""}`;
          },
        },
      ],
      // The metadata pre-filter above already applied `filter`; don't
      // re-filter TOON lines (ids would rarely match a prose filter).
      { limit: input.limit, offset: input.offset, full: input.full },
    );
    // Metadata-only payload for programmatic follow-ups (retry paths,
    // future manifest tooling) — bodies stay out by design.
    const value = {
      modules: matches.map((m) => ({
        id: m.id,
        slug: m.slug,
        displayName: m.displayName,
        description: m.description,
        kind: m.kind,
        ...(m.type !== undefined ? { type: m.type } : {}),
        fields: m.fields.map((f) => ({ name: f.name, kind: f.kind })),
        placementCount: usage.get(m.id)?.placementCount ?? 0,
        sampleSlugs: usage.get(m.id)?.sampleSlugs ?? [],
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
