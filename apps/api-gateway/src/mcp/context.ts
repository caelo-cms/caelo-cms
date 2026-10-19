// SPDX-License-Identifier: MPL-2.0

/**
 * What every remote-MCP handler gets: the loaded configuration and the
 * effects it may perform (outbound fetch, the clock), injected so tests
 * drive Google and the admin with local fakes.
 */

import type { McpConfig, McpSurface } from "./config.js";

export interface McpContext {
  readonly config: McpConfig;
  /** Outbound HTTP: Google's token endpoint, CIMD documents, the admin upstream. */
  readonly fetchImpl: typeof fetch;
  /** Current Unix time in seconds. */
  readonly nowSeconds: () => number;
}

/** The OAuth issuer: `iss` on every authorization response must equal it byte for byte. */
export function issuer(config: McpConfig): string {
  return `${config.publicUrl}/api/mcp/oauth`;
}

/** The protected-resource URL of one surface (what the user pastes into the MCP client). */
export function resourceUrl(config: McpConfig, surface: McpSurface): string {
  return `${config.publicUrl}/api/mcp/${surface}`;
}

/** Where `WWW-Authenticate: Bearer resource_metadata=…` points (reachable via /api/* on every stack). */
export function resourceMetadataUrl(config: McpConfig, surface: McpSurface): string {
  return `${config.publicUrl}/api/mcp/oauth/protected-resource/${surface}`;
}

/** The two resource URLs; a `resource` parameter must equal one of them. */
export function resourceUrls(config: McpConfig): readonly string[] {
  return [resourceUrl(config, "chat"), resourceUrl(config, "admin")];
}
