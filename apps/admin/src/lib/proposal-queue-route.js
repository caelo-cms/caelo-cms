// SPDX-License-Identifier: MPL-2.0
/**
 * Where a pending proposal's Approve / Reject form actions live.
 *
 * The convention is `/settings/<domain>/pending`, but a few domains' Owner
 * pages sit under a different path segment than their op-domain name (the
 * `deploy` ops live under /settings/deployments, `email_config` under
 * /settings/email, …). The chat's pending strip posts Approve to this URL,
 * so a domain missing here renders buttons that post to a 404.
 */
const QUEUE_ROUTE_OVERRIDES = {
    deploy: "/settings/deployments/pending",
    email_config: "/settings/email/pending",
    ai_providers: "/settings/ai/pending",
    mcp_tokens: "/settings/mcp/pending",
    owner_settings: "/settings/owner-settings/pending",
    // Site SEO proposals are approved on the SEO settings page, which exposes
    // the same `?/approve` + `?/reject` actions.
    site_defaults: "/settings/seo",
    // needsApproval tool calls (pending_proposals.list domain `tool_approvals`).
    tool_approvals: "/settings/tool-approvals/pending",
    // #684 — these two decide on their feature page, which exposes
    // `?/approve` + `?/reject` for the chat's pending strip.
    site_memory: "/settings/ai/memory-proposals",
    skills: "/settings/skills",
    // Executor op domains whose queue page sits under another segment
    // (`imports.execute_proposal`, `quality_audits.execute_proposal`).
    imports: "/settings/import/pending",
    quality_audits: "/settings/quality/pending",
};
/** The pending-queue page for a `pending_proposals.list` domain. */
export function proposalQueueRoute(domain) {
    return QUEUE_ROUTE_OVERRIDES[domain] ?? `/settings/${domain}/pending`;
}
