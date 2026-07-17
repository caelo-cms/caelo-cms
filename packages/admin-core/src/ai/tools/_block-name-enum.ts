// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.3 (issue #106) — shared AI-actionable block-name error. The
 * generation-time enum narrowing that used to live here (describeSchema)
 * was removed 2026-07: tool definitions are static now (prompt-cache),
 * and this structured error carrying the valid set is the constraint
 * lever (recover-don't-punt).
 */

import type { ToolResult } from "./dispatch.js";

/**
 * v0.12.3 (issue #106) — the shared AI-actionable error returned when a
 * tool's block-name argument names a slot that doesn't exist on the page's
 * template. Used by `add_module_to_page` and `move_module` so both block-
 * name paths fail loud + identically (CLAUDE.md §1A — recover, don't punt):
 * the body names the valid set and the nextAction points at the read-only
 * inspect_page_render so the AI re-picks within the turn.
 */
export function blockNotFoundError(opts: {
  blockName: string;
  blockNames: readonly string[];
  pageId: string;
  /** the offending argument's name, so the recovery hint is precise. */
  argName: string;
}): ToolResult {
  const allowed = opts.blockNames.join(", ");
  return {
    ok: false,
    content: `block "${opts.blockName}" does not exist on this page's template. Available blocks: ${allowed}`,
    nextAction: {
      tool: "inspect_page_render",
      args: { pageId: opts.pageId },
      reason: `the page's template defines blocks [${allowed}]; pick one of those for ${opts.argName} and retry`,
    },
  };
}
