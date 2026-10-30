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
  flattenTokens,
  fontAxisPolicy,
  fontRef,
  listThemeCssVarNames,
  scanCssVars,
  type ThemeDocument,
} from "@caelo-cms/shared";
import { z } from "zod";
import {
  SPACING_RHYTHM_HINTS,
  TOKEN_ROLE_HINTS,
  TOKEN_SHAPE_HINTS,
  TYPOGRAPHY_COMPOSITION_HINTS,
} from "../theme-guidance.js";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";

const setThemeTokensToolInput = z
  .object({
    themeSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional()
      .describe("Omit = active theme."),
    fontBindings: z
      .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,79}$/), fontRef)
      .optional()
      .describe(
        "Pin exact font files per role (e.g. `body`, `heading`) with `{id, sha256}` from `find_fonts`/`acquire_font`.",
      ),
    fontAxes: z
      .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,79}$/), fontAxisPolicy.nullable())
      .optional()
      .describe(
        'Which part of a pinned VARIABLE font visitors download, per role, e.g. `{heading:{opsz:"full"}}`, `{body:{wght:{min:400,max:700}}}`; `null` resets a role. ' +
          'Per axis: "full" = whole range | `{min,max}` clamps | number pins. Policy belongs to the font FILE -> applies to every role using it. ' +
          "Default (usually right): wght clamped to the weights the site renders, other axes pinned to the font default (~halves Inter's download). " +
          'Trade-offs: pinned opsz renders large headings in the text optical size (heavier, less refined) -> `{opsz:"full"}` to keep optical sizes; a wght range excluding a used weight renders that text at the nearest kept weight. ' +
          'Read current policy + byte sizes first via `get_theme(as:"font-delivery")`. Axes/values the font lacks are rejected with its real ranges.',
      ),
    set: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Add/replace tokens by loose name (`primaryColor`, `fontHeading`, `spacingLg`) or canonical path; value rules under `tokens`. " +
          "Ambiguous bare name -> `UnknownTokenName` with did-you-mean -> retry with the canonical path.",
      ),
    tokens: z
      .union([z.record(z.string(), z.unknown()), z.string()])
      .optional()
      .describe(
        "(Partial) DTCG document in the `get_theme`/`propose_create_theme` shape (`{color:{primary:{$value:'#4338ca', $description:'…'}}, typography:{…}}`); " +
          "every `{$value}` leaf is upserted at its path -> a whole composed palette in one call. Rules for values via `tokens` or `set`: " +
          `${TOKEN_SHAPE_HINTS} ${SPACING_RHYTHM_HINTS} ${TOKEN_ROLE_HINTS} ${TYPOGRAPHY_COMPOSITION_HINTS}`,
      ),
    remove: z.array(z.string()).optional().describe("Canonical paths to drop."),
  })
  .strict();
type SetThemeTokensToolInput = z.infer<typeof setThemeTokensToolInput>;

/**
 * e2e-livedit detected bugs — the AI composed a full DTCG document (the
 * shape every other theme surface shows it: get_theme, propose_create_theme,
 * the theme guidance's document skeleton) and passed it as `tokens`, which
 * this tool did not accept. A document is a legitimate way to state many
 * tokens at once, so it is accepted and turned into `set` entries keyed by
 * canonical path: the op's normaliser takes a `{$value, $description}`
 * envelope at a canonical path as-is.
 *
 * @returns the merged `set`, or an AI-actionable message when the document
 *   is not JSON, holds no `{$value}` leaf, or names a path `set` also writes.
 */
export function mergeTokenDocumentIntoSet(
  tokens: Record<string, unknown> | string,
  set: Record<string, unknown> | undefined,
): { ok: true; set: Record<string, unknown> } | { ok: false; message: string } {
  let doc: unknown = tokens;
  if (typeof tokens === "string") {
    try {
      doc = JSON.parse(tokens) as unknown;
    } catch (e) {
      return {
        ok: false,
        message: `\`tokens\` is not a JSON document (${(e as Error).message}) — pass it as an object: {color: {primary: {$value: '#…'}}, …}.`,
      };
    }
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return {
      ok: false,
      message: "`tokens` must be a DTCG document object: {color: {primary: {$value: '#…'}}, …}.",
    };
  }
  const leaves = flattenTokens(doc as ThemeDocument);
  if (leaves.length === 0) {
    return {
      ok: false,
      message:
        "`tokens` holds no token: every token is a leaf with a `$value` ({color: {primary: {$value: '#4338ca'}}}). " +
        "For loose names (primaryColor: '#…') use `set` instead.",
    };
  }
  const merged: Record<string, unknown> = { ...(set ?? {}) };
  const clashes: string[] = [];
  for (const { path, token } of leaves) {
    if (path in merged) clashes.push(path);
    merged[path] = token;
  }
  if (clashes.length > 0) {
    return {
      ok: false,
      message: `${clashes.join(", ")} given in both \`tokens\` and \`set\` — state each token once.`,
    };
  }
  return { ok: true, set: merged };
}

export const updateThemeTokensTool: ToolDefinitionWithHandler<SetThemeTokensToolInput> = {
  name: "set_theme_tokens",
  description:
    "Update tokens of one theme: upsert per token (a complete replacement = pass every desired token); names are normalized to canonical paths and the result shows what was written.\n" +
    "DO NOT USE FOR: a new theme -> `propose_create_theme`.",
  schema: setThemeTokensToolInput,
  // issue #251 (WS5) — inputSchema derived from `schema` at registration.
  handler: async (ctx, input, toolCtx) => {
    const { tokens, ...opInput } = input;
    if (tokens !== undefined) {
      const merged = mergeTokenDocumentIntoSet(tokens, opInput.set);
      if (!merged.ok) return { ok: false, content: merged.message };
      opInput.set = merged.set;
    }
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "themes.update_tokens",
      opInput,
    );
    if (!r.ok) {
      return toolError(r.error, `themes.update_tokens failed: ${describeError(r.error)}`);
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
    `${shown.join("; ")}${more}. Update their CSS (update_modules_many / template / layout) or restore the token.`
  );
}
