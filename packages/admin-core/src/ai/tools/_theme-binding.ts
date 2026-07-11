// SPDX-License-Identifier: MPL-2.0

/**
 * issue #164 slice 2 — tool-side wrapper for mechanical token binding.
 * Fetches the active theme once and rewrites color/gradient literals
 * that equal token values to `var(--…)`; the caller writes the BOUND
 * css and appends the report so the AI sees exactly what was rewritten.
 */

import { execute } from "@caelo-cms/query-api";
import {
  applyThemeLiteralBinding,
  type ExecutionContext,
  formatBindingReport,
  type ThemeDocument,
} from "@caelo-cms/shared";
import type { ToolContext } from "./dispatch.js";

export async function bindCssToTheme(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  css: string,
): Promise<{ css: string; report: string }> {
  const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get_active", {});
  if (!res.ok) return { css, report: "" };
  const theme = (res.value as { theme: { tokens: ThemeDocument } | null }).theme;
  if (theme === null) return { css, report: "" };
  const bound = applyThemeLiteralBinding(css, theme.tokens);
  return { css: bound.css, report: formatBindingReport(bound) ?? "" };
}
