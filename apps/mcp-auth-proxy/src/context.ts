// SPDX-License-Identifier: MPL-2.0

/**
 * What every remote-MCP handler gets: the loaded configuration and the
 * effects it may perform (outbound fetch, the clock), injected so tests
 * drive Google and the admin with local fakes.
 */

import { MCP_ADDRESSES, type McpAddress, type McpConfig } from "./config.js";
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

/** The protected-resource URL of one address (what the user pastes into the MCP client). */
export function resourceUrl(config: McpConfig, address: McpAddress): string {
  return `${config.publicUrl}/api/mcp/${address}`;
}

/** Where `WWW-Authenticate: Bearer resource_metadata=…` points (reachable via /api/* on every stack). */
export function resourceMetadataUrl(config: McpConfig, address: McpAddress): string {
  return `${config.publicUrl}/api/mcp/oauth/protected-resource/${address}`;
}

/** Every resource URL; a `resource` parameter must equal one of them. */
export function resourceUrls(config: McpConfig): readonly string[] {
  return MCP_ADDRESSES.map((address) => resourceUrl(config, address));
}

/** The address a resource URL names, or null when it is none of this site's. */
export function addressOfResource(config: McpConfig, resource: string): McpAddress | null {
  return MCP_ADDRESSES.find((address) => resourceUrl(config, address) === resource) ?? null;
}

/** What `invalid_target` tells a client that named another resource. */
export const INVALID_RESOURCE_MESSAGE =
  "resource must be this site's /api/mcp/chat or /api/mcp/power URL";
