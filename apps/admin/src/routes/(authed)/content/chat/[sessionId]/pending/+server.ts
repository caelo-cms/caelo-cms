// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.63 — Per-chat pending-proposals fetch.
 *
 * The chat page renders a sticky strip at the top showing pending
 * `propose_*` queued from THIS session. ChatPanel calls this endpoint
 * on mount + after every successful tool-result so the strip stays in
 * sync with what the AI just proposed (or what an Owner just clicked
 * Approve on, removing the row).
 *
 * Filtering is client-side trivial — pending_proposals.list returns a
 * cross-domain unified set and includes `chatSessionId` per row. We
 * call the op with the human ctx, filter to params.sessionId, and
 * return the trimmed shape ChatPanel needs (proposalId, domain, kind,
 * summary). The per-domain pending pages keep their own actions; this
 * endpoint is a thin read-projection.
 *
 * Scope: GET only. Approve / Reject continue to go through the
 * existing /security/<domain>/pending form actions (the same path
 * ProposeCard uses) so we don't fork the action contract.
 */

import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

interface PendingItem {
  proposalId: string;
  domain: string;
  kind: string;
  summary: string;
  proposedAt: string;
  /** /security/<domain>/pending — where Approve / Reject post. */
  queueUrl: string;
}

export const GET: RequestHandler = async ({ params, locals }) => {
  requirePermission(locals, "content.read");
  if (!locals.user) throw error(401, "Not authenticated");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "pending_proposals.list", {
    limit: 200,
  });
  if (!r.ok) {
    return json({ items: [] satisfies PendingItem[] });
  }
  const v = r.value as {
    items: {
      proposalId: string;
      domain: string;
      kind: string;
      summary: string;
      proposedAt: string;
      chatSessionId: string | null;
    }[];
  };
  const items: PendingItem[] = v.items
    .filter((i) => i.chatSessionId === params.sessionId)
    .map((i) => ({
      proposalId: i.proposalId,
      domain: i.domain,
      kind: i.kind,
      summary: i.summary,
      proposedAt: i.proposedAt,
      queueUrl: `/security/${i.domain}/pending`,
    }));
  return json({ items });
};
