// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — which external MCP agent a chat record belongs to.
 *
 * An external agent reaches Caelo either with a bearer token (`mcp_tokens`,
 * the stdio shim) or over a remote connection authenticated by Google IAP
 * (`mcp_remote_connections`). Running-agent rows (0255) and paused approval
 * cards (0258) name exactly one of the two (migration 0319's CHECKs), and
 * every "this agent's own rows" lookup must match on both columns so a
 * token never reads or resumes a remote connection's rows and vice versa.
 *
 * In-process code passes the discriminated {@link McpAgentRef}; Query API
 * op inputs carry the flat optional ids ({@link mcpAgentInputShape}) — the
 * JSON boundary shape.
 */

import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

/** An external MCP agent: a bearer token or a remote (IAP) connection. */
export type McpAgentRef =
  | { readonly kind: "token"; readonly tokenId: string }
  | { readonly kind: "remote"; readonly connectionId: string };

/** The op-input fields naming an external agent; at most one is set. */
export const mcpAgentInputShape = {
  /** A token-authenticated agent (stdio shim). */
  mcpTokenId: z.string().uuid().optional(),
  /** A remote, IAP-authenticated agent (#806). */
  mcpRemoteConnectionId: z.string().uuid().optional(),
};

/** The flat op-input form of {@link mcpAgentInputShape}. */
export interface McpAgentFields {
  readonly mcpTokenId?: string | undefined;
  readonly mcpRemoteConnectionId?: string | undefined;
}

/** True when the fields name an agent (validation keeps it to one). */
export function namesMcpAgent(fields: McpAgentFields): boolean {
  return fields.mcpTokenId !== undefined || fields.mcpRemoteConnectionId !== undefined;
}

/** Zod refinement message + predicate: at most one agent id. */
export const atMostOneMcpAgent = {
  check: (fields: McpAgentFields): boolean =>
    !(fields.mcpTokenId !== undefined && fields.mcpRemoteConnectionId !== undefined),
  message: "name the external agent by mcpTokenId OR mcpRemoteConnectionId, not both",
};

/** The op-input fields for a ref (empty for none). */
export function mcpAgentOpFields(ref: McpAgentRef | undefined): McpAgentFields {
  if (!ref) return {};
  return ref.kind === "token"
    ? { mcpTokenId: ref.tokenId }
    : { mcpRemoteConnectionId: ref.connectionId };
}

/**
 * `mcp_token_id = … AND mcp_remote_connection_id = …` with NULL-safe
 * comparison, so the unset column must be NULL on the row too. Only call it
 * with fields that name an agent.
 */
export function sameMcpAgentSql(fields: McpAgentFields): SQL {
  return sql`mcp_token_id IS NOT DISTINCT FROM ${fields.mcpTokenId ?? null}::uuid
    AND mcp_remote_connection_id IS NOT DISTINCT FROM ${fields.mcpRemoteConnectionId ?? null}::uuid`;
}
