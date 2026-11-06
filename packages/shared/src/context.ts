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

/**
 * #1495 — the public page URLs of the build that is live, for a plugin
 * render that republishes into it (a plugin-data build). Host-side only:
 * it never crosses into plugin code.
 */
export interface LiveBuildUrls {
  /** pageId → the URL the live build shipped (its routing manifest). */
  readonly urls: ReadonlyMap<string, string>;
  /** Filled as the render asks for pages the live build does not ship. */
  readonly unknownPageIds: Set<string>;
  /**
   * The errors the host threw for those refusals. Identity tells a refusal
   * from any other error the render throws: `ctx.cms` runs in the host's
   * process (the sandbox has no `ctx.cms`), and plugin code has no handle
   * on this set.
   */
  readonly refusals: WeakSet<Error>;
}

/** Starts the message of a {@link LiveBuildUrls} refusal; the host marks those errors by it. */
export const LIVE_BUILD_REFUSAL = "LiveBuildPageRefused:";

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
   * For a plugin installed as an external artifact: the digest of the
   * artifact this call runs. Private storage operations accept the call
   * only while exactly this artifact is the active, granted one.
   */
  readonly pluginArtifactDigest?: string;
  /**
   * #650 — the public origin of the static build a plugin's render-time
   * call belongs to. `pages.resolve_public_urls` builds URLs on it
   * instead of the stored site base URL, so a Stage with its own staging
   * host gets staging URLs from plugins too. Set by the plugin host from
   * the render invocation only.
   */
  readonly renderSiteBaseUrl?: string;
  /**
   * #1495 — set on a plugin-data build's render: `pages.resolve_public_urls`
   * answers from these URLs instead of main, because a tick publishes
   * nothing a human did not. Set by the plugin host only.
   */
  readonly renderLiveUrls?: LiveBuildUrls;
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
