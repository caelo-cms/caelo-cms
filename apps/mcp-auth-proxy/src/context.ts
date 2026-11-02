// SPDX-License-Identifier: MPL-2.0

/**
 * What every remote-MCP handler gets: the loaded configuration and the
 * effects it may perform (outbound fetch, the clock), injected so tests
 * drive Google and the admin with local fakes.
 */

import type { McpConfig, McpSurface } from "./config.js";
import type { CimdCache } from "./registration.js";

/** Proxy limits (constants in production, shrunk by tests). */
export interface ProxyLimits {
  /** How long the admin may take to answer with headers before the proxy gives up (504). */
  readonly firstResponseTimeoutMs: number;
  /** Largest MCP request body forwarded (413 beyond it). */
  readonly maxBodyBytes: number;
}

export interface McpContext {
  readonly config: McpConfig;
  /** Outbound HTTP: Google's token endpoint, CIMD documents, the admin upstream. */
  readonly fetchImpl: typeof fetch;
  /** Current Unix time in seconds. */
  readonly nowSeconds: () => number;
  /** The router's CIMD document cache. */
  readonly cimdCache: CimdCache;
  readonly proxyLimits: ProxyLimits;
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
