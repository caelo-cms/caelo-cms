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
}
