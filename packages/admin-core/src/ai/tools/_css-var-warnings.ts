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
  if (css === undefined || css.trim().length === 0) return "";
  const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get_active", {});
  if (!res.ok) return "";
  const theme = (res.value as { theme: { tokens: ThemeDocument } | null }).theme;
  if (theme === null) return "";
  const warning = formatUnknownCssVarWarning(
    scanCssVars({ css, knownVars: listThemeCssVarNames(theme.tokens) }),
  );
  return warning === null ? "" : ` ${warning}`;
}
