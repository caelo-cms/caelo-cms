// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — the credential fields of the `mcp.*` ops (a bearer token or
 * a remote IAP credential), in a leaf module: mcp_tokens.ts and
 * mcp_principal.ts import each other's functions, and these schemas are
 * read while their op definitions evaluate, so they must not sit on that
 * cycle. See mcp_principal.ts for how a credential resolves.
 */

import {
  MCP_ADDRESS_NAMES,
  MCP_SURFACE_NAMES,
  type McpSurfaceName,
  mcpSurfaceOf,
  storedMcpSurfaceValues,
} from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

/** An MCP surface: `chat` (caelo_chat) or `power` (Power-MCP). */
export const mcpRemoteSurface = z.enum(MCP_SURFACE_NAMES);
export type McpRemoteSurface = z.infer<typeof mcpRemoteSurface>;

/**
 * A surface as a row stores it (`mcp_tokens.scope`,
 * `mcp_remote_connections.surface`): rows from before #1636 say `admin` for
 * the Power surface. Everything written since says `power`; reads take both
 * through {@link mcpSurfaceFromStored} and {@link storedSurfaceIs}, so no
 * row had to be rewritten under a running release. The old spelling goes
 * with 1.0 (#1638).
 */
const storedMcpSurface = z.enum(MCP_ADDRESS_NAMES).transform(mcpSurfaceOf);

/** The surface a stored value names; throws on a value no release ever wrote. */
export function mcpSurfaceFromStored(stored: string): McpSurfaceName {
  return storedMcpSurface.parse(stored);
}

/**
 * The surface of a payload that never passed the op's Zod schema again (an
 * approval card queued before #1636 holds `scope: "admin"`).
 */
export function mcpSurfaceFromPayload(value: string | undefined): McpSurfaceName {
  return value === undefined ? "chat" : mcpSurfaceFromStored(value);
}

/**
 * SQL: `column` holds `surface`, in either spelling. One value for `chat`,
 * so the unique index on (actor_id, surface, client_key) still serves it.
 */
export function storedSurfaceIs(column: SQL, surface: McpSurfaceName): SQL {
  return surface === "power"
    ? sql`${column} IN (${sql.join(
        storedMcpSurfaceValues(surface).map((v) => sql`${v}`),
        sql`, `,
      )})`
    : sql`${column} = ${surface}`;
}

/**
 * The header the MCP-Auth-Proxy names the client app in (URI-encoded;
 * apps/mcp-auth-proxy/src/proxy.ts). Its value is the app's key from the
 * broker's sealed access token (issue #968).
 */
export const MCP_CLIENT_HEADER = "x-caelo-mcp-client";

/** A client app's key ({@link MCP_CLIENT_HEADER}); same bound as the gateway's. */
export const mcpClientKey = z.string().min(1).max(200);

/** The remote credential an `/api/mcp/remote/<surface>` request carries into an op. */
export const mcpRemoteCredential = z
  .object({
    /** The request's `x-goog-iap-jwt-assertion`; re-verified by the op. */
    iapCredential: z.string().min(16).max(16_384),
    surface: mcpRemoteSurface,
    /**
     * The client app the gateway named ({@link MCP_CLIENT_HEADER}). It picks
     * the user's connection row; it grants nothing — IAP and the user's role
     * decide access. See docs/dev/mcp-access.md for why a caller that skips
     * the gateway can name any app and still gains nothing.
     */
    client: mcpClientKey,
  })
  .strict();
export type McpRemoteCredential = z.infer<typeof mcpRemoteCredential>;

/**
 * The credential fields every `mcp.*` op accepts; exactly one is set
 * ({@link exactlyOneMcpCredential}). `plaintextToken` and
 * `remote.iapCredential` match the audit redaction pattern, so neither secret
 * reaches an audit hash.
 */
export const mcpCredentialShape = {
  plaintextToken: z.string().min(8).max(200).optional(),
  remote: mcpRemoteCredential.optional(),
};

/** The flat input form of {@link mcpCredentialShape}. */
export interface McpCredentialInput {
  readonly plaintextToken?: string | undefined;
  readonly remote?: McpRemoteCredential | undefined;
}

/** Zod refinement: a request authenticates one way, never both or neither. */
export const exactlyOneMcpCredential = {
  check: (v: { readonly plaintextToken?: unknown; readonly remote?: unknown }): boolean =>
    (v.plaintextToken !== undefined) !== (v.remote !== undefined),
  message: "authenticate with exactly one of plaintextToken or remote",
};
