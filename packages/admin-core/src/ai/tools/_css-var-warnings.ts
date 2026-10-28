// SPDX-License-Identifier: MPL-2.0

/**
 * issue #156 — write-time CSS var guard shared by the module/template
 * authoring tools.
 *
 * The write SUCCEEDS regardless (a warning, not a gate — an unknown var
 * can be legitimate mid-refactor, e.g. writing module CSS before the
 * matching theme token lands in the same turn); the warning rides the
 * tool result so the AI fixes drift in the same turn instead of the
 * operator discovering a monochrome section three pages later.
 */

import { execute } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  extractCssVarDefinitions,
  formatUnknownCssVarWarning,
  listThemeCssVarNames,
  scanCssVars,
  type ThemeDocument,
} from "@caelo-cms/shared";
import type { ToolContext } from "./dispatch.js";

/**
 * Scan authored CSS against the active theme's emitted var names.
 * Returns a suffix to append to the tool's success content: either
 * ` <warning>` or "" (clean write / no active theme — the cold-start
 * gate owns the no-theme state; double-nagging here is noise).
 */
export async function cssVarWarningSuffix(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  css: string | undefined,
): Promise<string> {
  const [warning] = await cssVarWarnings(ctx, toolCtx, [css]);
  return warning ? ` ${warning}` : "";
}

/**
 * The same scan for several CSS sources at once (one theme read), so a
 * multi-module tool can attribute each warning to the module whose CSS
 * caused it. Returns one entry per input: the warning, or "".
 *
 * A custom property one source defines (`:root { --gutter: … }` in one
 * module) is known to every source in the call — the modules ship together,
 * so another module using it is not drift. So is one a layout or template
 * defines (#1098): their CSS ships on the pages the module renders on, and
 * the preview's own scan (`pages.render_preview`) counts the whole bundle.
 */
export async function cssVarWarnings(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  cssList: ReadonlyArray<string | undefined>,
): Promise<string[]> {
  const empty = cssList.map(() => "");
  if (cssList.every((css) => css === undefined || css.trim().length === 0)) return empty;
  const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get_active", {});
  if (!res.ok) return empty;
  const theme = (res.value as { theme: { tokens: ThemeDocument } | null }).theme;
  if (theme === null) return empty;
  const chromeCss = await layoutAndTemplateCss(ctx, toolCtx);
  if (chromeCss === null) return empty;
  const knownVars = [
    ...listThemeCssVarNames(theme.tokens),
    ...[...cssList, ...chromeCss].flatMap((css) => (css ? [...extractCssVarDefinitions(css)] : [])),
  ];
  return cssList.map((css) =>
    css === undefined || css.trim().length === 0
      ? ""
      : (formatUnknownCssVarWarning(scanCssVars({ css, knownVars })) ?? ""),
  );
}

/**
 * The CSS of every layout and template the caller's branch sees, or null
 * when either read fails — then no warning is better than a false one.
 */
async function layoutAndTemplateCss(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
): Promise<string[] | null> {
  const [layouts, templates] = await Promise.all([
    execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.list", {}),
    execute(toolCtx.registry, toolCtx.adapter, ctx, "templates.list", {}),
  ]);
  if (!layouts.ok || !templates.ok) return null;
  return [
    ...(layouts.value as { layouts: { css: string }[] }).layouts.map((l) => l.css),
    ...(templates.value as { templates: { css: string }[] }).templates.map((t) => t.css),
  ];
}
