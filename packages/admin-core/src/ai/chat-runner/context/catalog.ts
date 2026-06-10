// SPDX-License-Identifier: MPL-2.0

/**
 * Content-catalog system-prompt context blocks — theme, structured sets,
 * modules (with the real placement-usage signal), content-instance library,
 * and media. Extracted verbatim from the pre-split `chat-runner.ts`
 * (v0.11.0 / v0.12.0 / P7).
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  formatThemeSummary,
  listThemeCssVarNames,
  type Theme,
  type ThemeDocument,
} from "@caelo-cms/shared";

import {
  formatContentLibraryBlock,
  formatModulesBlock,
  formatStructuredSetsBlock,
  formatThemeBlock,
} from "../../system-prompt.js";

/**
 * v0.12.0 — pull the module usage signal that the `## Modules`
 * decision-support block consumes. Wraps `modules.list_usage` and
 * returns the Map shape formatModulesBlock expects. Tolerates a
 * read failure (returns empty map; block renders modules as
 * "unplaced") so a flake here doesn't block the chat turn.
 */
export async function loadModuleUsageSignal(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
): Promise<ReadonlyMap<string, { placementCount: number; sampleSlugs: readonly string[] }>> {
  const r = await execute(registry, adapter, ctx, "modules.list_usage", {});
  if (!r.ok) return new Map();
  const { usage } = r.value as {
    usage: { moduleId: string; placementCount: number; sampleSlugs: string[] }[];
  };
  return new Map(
    usage.map((u) => [
      u.moduleId,
      { placementCount: u.placementCount, sampleSlugs: u.sampleSlugs },
    ]),
  );
}

export interface CatalogBlocks {
  themeBlock: string | undefined;
  structuredSetsBlock: string | undefined;
  modulesBlock: string | undefined;
  contentLibraryBlock: string | undefined;
  mediaBlock: string | undefined;
}

/**
 * Builds the theme / structured-sets / modules / content-library / media
 * context blocks. `humanCtx` is used for site-wide reads; `humanCtxWithBranch`
 * for branch-aware reads (modules + content instances must see the chat's own
 * in-flight branched-create entities).
 */
export async function buildCatalogBlocks(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  humanCtxWithBranch: ExecutionContext,
): Promise<CatalogBlocks> {
  // v0.11.0 (#45) — themes primitive. Load the active theme (one row,
  // is_active=true) and render the dedicated ## Theme system-prompt
  // block via formatThemeBlock.
  let themeBlock: string | undefined;
  const activeThemeR = await execute(registry, adapter, humanCtx, "themes.get_active", {});
  if (activeThemeR.ok) {
    // Round-2 opt §3: cast to the typed Theme aggregate (op output schema)
    // instead of a hand-rolled partial; surfaces compile-time errors if
    // themes.get_active's output ever drifts.
    const { theme } = activeThemeR.value as { theme: Theme | null };
    if (theme) {
      themeBlock = formatThemeBlock({
        slug: theme.slug,
        displayName: theme.displayName,
        // Round-2 opt §4: surface the operator-supplied description so
        // multi-theme installs (v0.11.1+) let the AI pick the right slug
        // by intent (e.g. "Brand Orange — campaign-page variant").
        description: theme.description,
        // v0.11.4 (issue #76 follow-up) — surface provenance so the AI
        // knows whether to evolve (`seed`) or preserve (`ai`/`operator`).
        origin: theme.origin,
        // v0.11.1 (issue #76) — formatThemeSummary replaces the v0.11.0
        // category-count `summarizeTokens` so the system prompt carries
        // the palette/font/radius shorthand the AI actually uses to pick
        // matching module styling.
        tokensSummary: formatThemeSummary(theme.tokens as ThemeDocument),
        // v0.11.4 (issue #76 follow-up) — list the actual CSS var names
        // the renderer emits for this theme. Without this the AI guesses
        // names (--color-text, --color-surface) that don't exist in
        // shadcn-style themes, and module CSS falls through to hardcoded
        // slate/white fallbacks. With this, the AI uses real var names.
        cssVarNames: listThemeCssVarNames(theme.tokens as ThemeDocument),
      });
    } else {
      themeBlock = formatThemeBlock(null);
    }
  }

  let structuredSetsBlock: string | undefined;
  const setsR = await execute(registry, adapter, humanCtx, "structured_sets.list", {});
  if (setsR.ok) {
    const sets = (
      setsR.value as {
        sets: { kind: string; slug: string; displayName: string; items: unknown }[];
      }
    ).sets;
    structuredSetsBlock = formatStructuredSetsBlock(sets);
  }

  // v0.12.0 — `## Modules` decision-support catalog. Per CLAUDE.md §1A
  // the AI picks modules by intent (kind + description), so this
  // block sorts by kind and surfaces description + REAL placement
  // usage + a short field summary per module.
  let modulesBlock: string | undefined;
  const modulesR = await execute(registry, adapter, humanCtxWithBranch, "modules.list", {});
  if (modulesR.ok) {
    const { modules: mods } = modulesR.value as {
      modules: {
        id: string;
        slug: string;
        displayName: string;
        description: string;
        kind: "chrome" | "hero" | "content" | "cta" | "utility";
        // v0.12.3 (issue #106) — surfaced so the `## Modules` block shows
        // each module's stable type + each nested field's allowedModuleTypes.
        type: string;
        fields: { name: string; kind: string; allowedModuleTypes?: string[] }[];
      }[];
    };
    // Real usage signal: one query joins page_modules → pages,
    // groups by module_id, returns count + a deterministic top-3
    // page slugs per module. The result is a Map the block formatter
    // consumes; modules with zero placements stay out of the map and
    // the formatter renders them as "unplaced".
    const usageByModuleId = await loadModuleUsageSignal(registry, adapter, humanCtxWithBranch);
    modulesBlock = formatModulesBlock(mods, usageByModuleId);
  }

  // v0.12.0 — content_instances inventory block. Branch-aware so chats
  // see their own in-flight branched-create instances. Per CLAUDE.md
  // §1A this block carries decision-support context (purpose +
  // placementCount + sample slugs) so the AI can decide reuse vs
  // fork vs mint new without round-tripping back to the operator.
  let contentLibraryBlock: string | undefined;
  const instancesR = await execute(
    registry,
    adapter,
    humanCtxWithBranch,
    "content_instances.list",
    {},
  );
  if (instancesR.ok) {
    const { instances } = instancesR.value as {
      instances: {
        id: string;
        moduleSlug: string;
        moduleKind?: "chrome" | "hero" | "content" | "cta" | "utility";
        slug: string | null;
        displayName: string | null;
        purpose?: string | null;
        placementCount: number;
      }[];
    };
    contentLibraryBlock = formatContentLibraryBlock(instances);
  }

  // P7 — recent + most-used media so the AI can pick existing assets
  // before suggesting an upload. URLs use the WebP-800 variant for
  // raster images, `orig` for SVG / PDF / video. The composed page is
  // already in `pageContextBlock` with literal /_caelo/media/... URLs;
  // this block surfaces the *catalogue* of what's available beyond
  // what the page currently uses.
  let mediaBlock: string | undefined;
  const mediaR = await execute(registry, adapter, humanCtx, "media.recent_for_ai", { limit: 30 });
  if (mediaR.ok) {
    const assets = (
      mediaR.value as {
        assets: {
          id: string;
          mime: string;
          alt: string;
          width: number | null;
          height: number | null;
          originalName: string;
          usageCount: number;
        }[];
      }
    ).assets;
    if (assets.length > 0) {
      const RASTER = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);
      const lines = assets.map((a) => {
        const variant = RASTER.has(a.mime) ? "webp-800" : "orig";
        const dims = a.width && a.height ? `, ${a.width}x${a.height}` : "";
        const alt = a.alt ? `, alt="${a.alt}"` : "";
        const used = a.usageCount > 0 ? ` (used ${a.usageCount}×)` : "";
        return `- ${a.originalName} (${a.mime}${dims}${alt})${used} → /_caelo/media/${a.id}/${variant}`;
      });
      mediaBlock = [
        "# Media (recent + frequently used)",
        'Drop these URLs straight into module HTML via `<img src="..." alt="...">`. Always include a meaningful alt; if alt is empty above, ask the user or call `set_media_alt` if you have visual context. To search beyond this slice, call `find_media({ query, mime?, limit? })`. If nothing matches, ask the user to upload via /content/media.',
        ...lines,
      ].join("\n");
    }
  }

  return { themeBlock, structuredSetsBlock, modulesBlock, contentLibraryBlock, mediaBlock };
}
