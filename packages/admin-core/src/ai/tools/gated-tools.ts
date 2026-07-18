// SPDX-License-Identifier: MPL-2.0

/**
 * Gated tools — SDK-executed, human-approval-gated (CLAUDE.md §11.A, Plan B).
 *
 * A gated tool (any tool whose registry definition carries `gated`, set by
 * `makeProposeTool`) is the SDK-native replacement for the old
 * `propose_*` + `/security/pending` Approve dance: the AI calls the action
 * directly, but the SDK PAUSES on a `tool-approval-request` before running the
 * tool's `execute`. The Owner approves in-chat; the SDK then runs `execute`,
 * which chains the existing per-domain machinery:
 *
 *   1. `<domain>.propose_<action>` (AI ctx) — writes the pending row, computes
 *      the preview jsonb, records audit;
 *   2. `<domain>.execute_proposal({proposalId})` (Owner live ctx) — applies the
 *      real mutation, exactly as the /security/pending Approve did.
 *
 * Reusing propose/execute keeps every domain's apply logic correct (including
 * multi-op fan-outs like a layout's html+blocks) with ZERO reimplementation —
 * the SDK gate simply sits in front of it. The pending tables survive as the
 * internal apply + audit engine; only the AI-facing propose_* choreography and
 * the separate Owner queue are gone.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

import { describePersistError } from "../chat-runner/persistence.js";
import type { FilteredTool } from "../chat-runner/tool-catalogue.js";

/**
 * Attach the SDK `execute` to a gated catalogue tool. The returned tool ships
 * to the provider with `approvalMode` + `execute`; the SDK pauses before
 * `execute` until the Owner approves, then runs propose (AI) + execute_proposal
 * (Owner live). `ownerCtxLive` MUST be branch-free (a live-commit) so an
 * approved change applies site-wide immediately, matching the old flow.
 */
export function attachGatedExecute(
  tool: FilteredTool,
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  aiCtx: ExecutionContext,
  ownerCtxLive: ExecutionContext,
): FilteredTool {
  const gated = tool.gated;
  if (!gated) return tool;
  return {
    ...tool,
    approvalMode: "user-approval",
    execute: async (input: unknown): Promise<unknown> => {
      // 1. Propose as the AI — validates, writes the pending row + preview.
      const proposed = await execute(
        registry,
        adapter,
        aiCtx,
        gated.proposeOp,
        input as Record<string, unknown>,
      );
      if (!proposed.ok) {
        return {
          ok: false,
          error: `${gated.proposeOp} failed: ${describePersistError(proposed.error)}`,
        };
      }
      const proposalId = (proposed.value as { proposalId?: string }).proposalId;
      if (!proposalId) {
        return { ok: false, error: `${gated.proposeOp} returned no proposalId` };
      }
      // 2. Apply as the Owner (live-commit) — the approved mutation.
      const applied = await execute(registry, adapter, ownerCtxLive, gated.executeOp, {
        proposalId,
      });
      if (!applied.ok) {
        return {
          ok: false,
          error: `${gated.executeOp} failed: ${describePersistError(applied.error)}`,
        };
      }
      return { ok: true, value: applied.value };
    },
  };
}
