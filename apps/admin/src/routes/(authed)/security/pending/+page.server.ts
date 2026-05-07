// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.36 — Unified Owner inbox for AI-proposed actions across every
 * gated domain. Reads from pending_proposals.list (one UNION ALL across
 * the 15 *_pending tables shipped in v0.2.19→v0.2.30 + locale/gateway/
 * site_memory/skills) and renders one page with all of them.
 *
 * Replaces the per-domain navigation: instead of remembering whether
 * an invite is at /security/users/pending or /security/roles/pending,
 * the operator goes here, sees everything waiting, and clicks straight
 * through to the per-domain queue for approve/reject (the per-domain
 * UIs handle the per-domain action shapes — secret-supply for
 * email/ai_providers, password reveal for users/mcp_tokens, etc.).
 */

import { execute } from "@caelo-cms/query-api";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { PageServerLoad } from "./$types";

interface PendingItem {
  domain: string;
  kind: string;
  proposalId: string;
  summary: string;
  proposedBy: string;
  proposedAt: string;
  chatSessionId: string | null;
  chatSessionTitle: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
  // Owner-level surface — reuse the most permissive existing permission.
  // Per-domain queues each gate via their own (settings.write / content.write
  // / roles.manage) — this overview page lets any of those see the full set.
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "pending_proposals.list", {
    limit: 200,
  });
  if (!r.ok) {
    return { items: [] as PendingItem[], byDomain: {} as Record<string, number>, total: 0 };
  }
  const v = r.value as {
    items: PendingItem[];
    byDomain: Record<string, number>;
    total: number;
  };
  return v;
};
