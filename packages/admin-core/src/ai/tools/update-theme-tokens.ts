// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — AI tool: set_theme_tokens (#45 follow-up comment §1).
 *
 * The AI's primary way to edit a theme. Accepts loose names
 * (`primaryColor`, `fontHeading`, `spacingLg`, `radius`) — server
 * normalizes to canonical DTCG paths and returns what was written.
 * On ambiguity the server returns `UnknownTokenName` with did-you-mean
 * suggestions so the AI's retry lands.
 */

import { execute } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  listThemeCssVarNames,
  scanCssVars,
  type ThemeDocument,
} from "@caelo-cms/shared";
import { z } from "zod";
import { TOKEN_SHAPE_HINTS } from "../theme-guidance.js";
import { describeError } from "./_describe-error.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";

const setThemeTokensToolInput = z
  .object({
    /** Optional — defaults to the active theme. */
    themeSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    /** Loose-name → value map. Server normalizes to canonical paths. */
    set: z.record(z.string(), z.unknown()).optional(),
    /** Canonical DTCG paths to drop. */
    remove: z.array(z.string()).optional(),
  })
  .strict();
type SetThemeTokensToolInput = z.infer<typeof setThemeTokensToolInput>;

export const updateThemeTokensTool: ToolDefinitionWithHandler<SetThemeTokensToolInput> = {
  name: "set_theme_tokens",
  description:
    "Update theme tokens for one theme. Accepts loose names (`primaryColor`, `fontHeading`, " +
    "`spacingLg`) — server normalizes to canonical paths and returns what was written. " +
    "Pass `set` to add/replace tokens, `remove` to drop them. Works with the active theme " +
    "by default; pass `themeSlug` to target a specific theme. For a complete theme " +
    "replacement, use `set_theme_tokens` with all desired tokens (it's an upsert per token, " +
    "not per-theme). When ambiguous (a bare name with no value-shape signal) the tool " +
    "returns `UnknownTokenName` with did-you-mean suggestions; retry with the canonical " +
    "path. " +
    TOKEN_SHAPE_HINTS,
  schema: setThemeTokensToolInput,
  // issue #251 (WS5) — inputSchema derived from `schema` at registration.
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.update_tokens", input);
    if (!r.ok) {
      return { ok: false, content: `themes.update_tokens failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      themeId: string;
      canonicalPathsWritten: string[];
      canonicalPathsRemoved: string[];
    };
    const parts: string[] = [];
    if (v.canonicalPathsWritten.length > 0) {
      parts.push(`wrote ${v.canonicalPathsWritten.join(", ")}`);
    }
    if (v.canonicalPathsRemoved.length > 0) {
      parts.push(`removed ${v.canonicalPathsRemoved.join(", ")}`);
      // issue #156 — a removed token may still be referenced by stored
      // CSS; those references now silently fall back (the monochrome
      // trap). Scan modules + templates + layouts against the theme as
      // it stands POST-removal and name the affected entities so the
      // AI repairs them in the same turn instead of shipping drift.
      const dangling = await danglingCssVarReport(ctx, toolCtx);
      if (dangling !== null) parts.push(dangling);
    }
    return {
      ok: true,
      content: parts.length > 0 ? parts.join("; ") : "no-op (nothing to set or remove)",
    };
  },
};

/**
 * Scan every stored module/template/layout CSS against the ACTIVE
 * theme's emitted vars. Returns a capped, slug-attributed report of
 * unknown references, or null when everything resolves.
 */
async function danglingCssVarReport(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
): Promise<string | null> {
  const themeRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get_active", {});
  if (!themeRes.ok) return null;
  const theme = (themeRes.value as { theme: { tokens: ThemeDocument } | null }).theme;
  if (theme === null) return null;
  const knownVars = listThemeCssVarNames(theme.tokens);

  const entities: { slug: string; css: string }[] = [];
  const [mods, tpls, lays] = await Promise.all([
    execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.list", { includeDeleted: false }),
    execute(toolCtx.registry, toolCtx.adapter, ctx, "templates.list", {}),
    execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.list", {}),
  ]);
  if (mods.ok) {
    for (const m of (mods.value as { modules: { slug: string; css: string }[] }).modules) {
      entities.push({ slug: `module:${m.slug}`, css: m.css });
    }
  }
  if (tpls.ok) {
    for (const t of (tpls.value as { templates: { slug: string; css: string }[] }).templates) {
      entities.push({ slug: `template:${t.slug}`, css: t.css });
    }
  }
  if (lays.ok) {
    for (const l of (lays.value as { layouts: { slug: string; css: string }[] }).layouts) {
      entities.push({ slug: `layout:${l.slug}`, css: l.css });
    }
  }

  const hits: string[] = [];
  for (const e of entities) {
    if (e.css.trim().length === 0) continue;
    const unknown = scanCssVars({ css: e.css, knownVars });
    if (unknown.length > 0) {
      hits.push(`${e.slug} (${unknown.map((u) => u.name).join(", ")})`);
    }
  }
  if (hits.length === 0) return null;
  const shown = hits.slice(0, 10);
  const more = hits.length > shown.length ? ` … and ${hits.length - shown.length} more` : "";
  return (
    `⚠️ ${hits.length} stored CSS source(s) now reference vars this theme no longer emits: ` +
    `${shown.join("; ")}${more}. Update their CSS (edit_module / template / layout) or restore the token.`
  );
}
