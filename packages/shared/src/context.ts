// SPDX-License-Identifier: MPL-2.0

/**
 * Execution identity threaded through every Query API call. The Database Adapter
 * reads this to set `SET LOCAL caelo.actor_id / actor_kind / plugin_id` on the
 * transaction so RLS policies can scope rows.
 *
 * `actorId` being NULL must mean "no identity, deny by default" — the adapter
 * sets the session var to an empty string and every RLS policy's `NULLIF(...,'')::uuid`
 * yields NULL, which matches nothing.
 */

export type ActorKind = "human" | "ai" | "plugin" | "system";

export interface ExecutionContext {
  readonly actorId: string;
  readonly actorKind: ActorKind;
  /** Present only when the caller is a plugin. */
  readonly pluginId?: string;
  /** Opaque id for audit trace / log correlation. */
  readonly requestId: string;
  /**
   * P5: when set, all snapshot rows emitted by ops in this transaction
   * carry this chat_branch_id. Reads that opt into branch-aware mode
   * resolve the chat's branch state when present, else fall back to main.
   */
  readonly chatBranchId?: string;
  /**
   * P5: when set, snapshots emitted during this op group under the same
   * chat_task_id so the timeline UX (P10A's task-grouped collapsing) can
   * fold consecutive AI actions into one entry.
   */
  readonly chatTaskId?: string;
  /**
   * P10.5: parent attribution for subagent invocations. When the
   * `spawn_subagent` tool calls runChatTurn for the child, it carries
   * these fields so the existing ai_calls + audit_events writers
   * persist them to the new schema columns. Same code paths; just
   * more attribution data threaded through.
   */
  readonly parentChatSessionId?: string;
  readonly parentAiCallId?: string;
}
