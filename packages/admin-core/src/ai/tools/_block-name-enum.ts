// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.3 (issue #106) — generation-time block-name constraint.
 *
 * `add_module_to_page` and `move_module` both take a block-name argument
 * that must name a real slot on the focused page's template. Rather than
 * let the model guess and rely on a validator rejection (the weakest
 * reliability lever — and the one the AI then punted to the operator),
 * we narrow the argument to a JSON-Schema `enum` of the focused page's
 * actual blocks at generation time, via the tool's `describeSchema` hook.
 *
 * The op-layer Validator still rejects an out-of-set block as
 * defense-in-depth (enum adherence isn't guaranteed across providers, and
 * the AI may target a page other than the focused one — CLAUDE.md §2).
 */

import type { ToolDescribeState } from "./describe-state.js";
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

/**
 * Clone `base` with `blockArg` pinned to an enum of the focused page's
 * template blocks. Returns `base` unchanged when there is no focused page
 * or it declares zero blocks — an empty enum matches nothing and would
 * wedge the model, so we fall back to the static free-string schema.
 */
export function withBlockNameEnum(
  base: Record<string, unknown>,
  state: ToolDescribeState,
  blockArg: string,
): Record<string, unknown> {
  const blocks = state.activePage?.blockNames ?? [];
  if (blocks.length === 0) return base;
  const properties = base.properties as Record<string, unknown>;
  const existing = (properties[blockArg] ?? {}) as Record<string, unknown>;
  return {
    ...base,
    properties: {
      ...properties,
      [blockArg]: {
        ...existing,
        type: "string",
        enum: [...blocks],
        description: `the block to place into — one of this page's template blocks: ${blocks.join(", ")}`,
      },
    },
  };
}
