// SPDX-License-Identifier: MPL-2.0

/**
 * Discovery documents (issue #806): RFC 9728 protected-resource metadata
 * per MCP surface, and RFC 8414 authorization-server metadata for the
 * broker. MCP clients probe different paths, so the same documents are
 * served under each OAuth variant they use.
 */

import { mcpSurfaceOf } from "@caelo-cms/shared";
import { MCP_ADDRESS_ALTERNATION, type McpAddress, type McpConfig } from "./config.js";
import { issuer, resourceUrl } from "./context.js";
import { GOOGLE_SCOPES } from "./google.js";
import { json } from "./http.js";

/** Scopes this broker advertises (the Google scopes it asks for). */
const SCOPES = GOOGLE_SCOPES.split(" ");

/** RFC 9728 document for one address. */
export function protectedResourceMetadata(config: McpConfig, address: McpAddress): Response {
  return json({
    resource: resourceUrl(config, address),
    authorization_servers: [issuer(config)],
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPES,
    resource_name: mcpSurfaceOf(address) === "chat" ? "Caelo (chat)" : "Caelo (Power-MCP)",
  });
}

/** RFC 8414 document for the broker. */
export function authorizationServerMetadata(config: McpConfig): Response {
  const iss = issuer(config);
  return json({
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    registration_endpoint: `${iss}/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: SCOPES,
  });
}

/**
 * Paths that serve {@link authorizationServerMetadata}: RFC 8414's
 * path-inserted form and the path-appended form some clients probe.
 *
 * No `openid-configuration` aliases: this broker is not an OpenID
 * Provider (no `jwks_uri`, no ID tokens of its own, no userinfo), and a
 * document served there would claim to be OIDC discovery while missing
 * the fields OpenID Connect Discovery 1.0 §3 makes mandatory. MCP clients
 * try RFC 8414 discovery first and only fall back to OIDC discovery
 * (MCP authorization spec, "Authorization Server Metadata Discovery"), and
 * every client on the redirect allowlist finds this AS through RFC 8414.
 */
export const AS_METADATA_PATHS: readonly string[] = [
  "/.well-known/oauth-authorization-server/api/mcp/oauth",
  "/api/mcp/oauth/.well-known/oauth-authorization-server",
];

const WELL_KNOWN_PROTECTED_RESOURCE = new RegExp(
  `^/\\.well-known/oauth-protected-resource/api/mcp/(${MCP_ADDRESS_ALTERNATION})$`,
);
const OAUTH_PROTECTED_RESOURCE = new RegExp(
  `^/api/mcp/oauth/protected-resource/(${MCP_ADDRESS_ALTERNATION})$`,
);

/** The address whose protected-resource metadata `pathname` asks for, or null. */
export function protectedResourceAddress(pathname: string): McpAddress | null {
  const m = WELL_KNOWN_PROTECTED_RESOURCE.exec(pathname) ?? OAUTH_PROTECTED_RESOURCE.exec(pathname);
  return m ? (m[1] as McpAddress) : null;
}
