// SPDX-License-Identifier: MPL-2.0

/**
 * FIXME(issue #1331): the header the MCP-Auth-Proxy's interim forwarder
 * (apps/mcp-auth-proxy server.ts) sets to the host a client asked for, and
 * the visitor gateway's staging gate (apps/api-gateway staging-proxy.ts)
 * reads. One name for both ends of the contract.
 *
 * On gcp-firebase the Cloud Run service `gateway` became the MCP-Auth-Proxy
 * (#1328, E13 a), while an existing staging domain mapping (#650) and the
 * live release's Firebase `/api/**` rewrite still point at it. The proxy
 * streams that traffic to the data gateway's run.app URL; Cloud Run routes
 * by Host, so the original host travels in this header. Removed with the
 * staging cutover (P3b-3).
 */
export const INTERIM_FORWARDED_HOST_HEADER = "x-caelo-forwarded-host";
