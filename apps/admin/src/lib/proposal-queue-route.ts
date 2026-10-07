// SPDX-License-Identifier: MPL-2.0

/**
 * Where a pending proposal's Approve / Reject form actions live.
 *
 * The convention is `/security/<domain>/pending`, but a few domains' Owner
 * pages sit under a different path segment than their op-domain name (the
 * `deploy` ops live under /security/deployments, `email_config` under
 * /security/email, …). The chat's pending strip posts Approve to this URL,
 * so a domain missing here renders buttons that post to a 404.
 */
const QUEUE_ROUTE_OVERRIDES: Readonly<Record<string, string>> = {
  deploy: "/security/deployments/pending",
  email_config: "/security/email/pending",
  ai_providers: "/security/ai/pending",
  mcp_tokens: "/security/mcp/pending",
  owner_settings: "/security/owner-settings/pending",
};

/** The pending-queue page for a `pending_proposals.list` domain. */
export function proposalQueueRoute(domain: string): string {
  return QUEUE_ROUTE_OVERRIDES[domain] ?? `/security/${domain}/pending`;
}
