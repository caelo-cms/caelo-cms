// SPDX-License-Identifier: MPL-2.0

/**
 * Security headers of the gateway's JSON answers (#1326, #763 L2): plugin
 * operations, the captcha challenge, health, the staging gate's JSON. The
 * definition is shared with the MCP-Auth-Proxy (@caelo-cms/shared
 * json-security-headers.ts, #1328); the gateway's callers keep importing it
 * from here.
 */

export {
  addJsonSecurityHeaders,
  isJsonResponse,
  JSON_SECURITY_HEADERS,
  withJsonSecurityHeaders,
} from "@caelo-cms/shared";
