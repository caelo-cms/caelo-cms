// SPDX-License-Identifier: MPL-2.0

/**
 * Gated tools — SDK-executed, human-approval-gated (CLAUDE.md §11.A, Slice 1).
 *
 * These are the SDK-native replacement for the `propose_*`/`execute_proposal`
 * pattern: the AI calls the REAL op directly, but the tool is marked
 * `approvalMode: "user-approval"` so the SDK PAUSES before its `execute` and
 * emits a `tool-approval-request`. The Owner approves in-chat; the SDK then
 * runs `execute`, which calls the underlying op with the OWNER's live
 * ExecutionContext (no chat branch — an approved change commits live, exactly
 * as the old execute_proposal did).
 *
 * Unlike the dispatch-registry tools (`ToolDefinitionWithHandler`), gated
 * tools are SDK-executed only: our chat-runner loop never dispatches them (it
 * surfaces the approval and stops/resumes). They are appended to the provider
 * catalogue by the chat-runner, which supplies the runtime `execute` closure.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

import type { ToolDefinition } from "../provider.js";
import { describePersistError } from "../chat-runner/persistence.js";

/** Static spec for a gated tool: what the model sees + which op it runs. */
export interface GatedToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** The real Query API op the approved execute runs (Owner scope). */
  readonly opName: string;
  /**
   * The `propose_*` tool this gated tool SUPERSEDES, filtered out of the
   * catalogue when this gated tool is present so the model has ONE way to do
   * the action. Removed outright once the fan-out (Slice 2) retires the
   * propose tools.
   */
  readonly supersedes?: string;
}

/**
 * Slice 1 — layouts is the first gated domain (it motivated the switch: the
 * AI's white-band CSS fix sat unapproved in the old propose queue). More
 * domains fold in during the fan-out (Slice 2).
 */
export const GATED_TOOL_SPECS: readonly GatedToolSpec[] = [
  {
    name: "update_layout",
    description:
      "Update an existing layout — its html, css, and/or displayName. Site-wide chrome: the change cascades to every page on every bound template, so it is APPROVAL-GATED — calling it pauses for the Owner's in-chat Approve before anything changes. Do not claim the layout changed until it is approved.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["layoutId"],
      properties: {
        layoutId: { type: "string", format: "uuid" },
        displayName: { type: "string", minLength: 1, maxLength: 200 },
        html: { type: "string", minLength: 1, maxLength: 50_000 },
        css: { type: "string", maxLength: 50_000 },
      },
    },
    opName: "layouts.update",
    supersedes: "propose_update_layout",
  },
];

/** Tool names of every `propose_*` tool a gated tool supersedes. */
export const SUPERSEDED_PROPOSE_TOOLS: ReadonlySet<string> = new Set(
  GATED_TOOL_SPECS.map((g) => g.supersedes).filter((n): n is string => n !== undefined),
);

/**
 * Build the provider-facing gated tools for a turn, closing `execute` over the
 * OWNER's live context (no chatBranchId — an approved change commits live).
 * The SDK only calls `execute` AFTER the Owner approves; on the propose turn
 * it stays unrun (the turn pauses on the tool-approval-request).
 */
export function buildGatedFilteredTools(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ownerCtxLive: ExecutionContext,
): ToolDefinition[] {
  return GATED_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    alwaysLoaded: true,
    approvalMode: "user-approval" as const,
    execute: async (input: unknown): Promise<unknown> => {
      const r = await execute(
        registry,
        adapter,
        ownerCtxLive,
        spec.opName,
        input as Record<string, unknown>,
      );
      if (r.ok) return { ok: true, value: r.value };
      return { ok: false, error: describePersistError(r.error) };
    },
  }));
}
