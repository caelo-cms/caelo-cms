// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — the AI's Go live now (CLAUDE.md §11.A): the redirect tools queue
 * a `redirects.propose_go_live` proposal and answer in the canonical
 * "Queued proposal <id>: …" shape, so the chat shows the approval card with
 * Approve / Reject. The approval runs `redirects.execute_go_live` as the
 * approver, who needs the Publish live permission; until then the changes
 * stay Staged.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolContext } from "./dispatch.js";

/** Where the approval card's buttons post (Settings → Redirects decides them). */
export const REDIRECT_PROPOSAL_QUEUE = "/settings/redirects/pending";

/**
 * Propose Go live now for `fromPaths`. Returns the line a tool result must
 * START with (the card), or why nothing was proposed.
 */
export async function proposeRedirectGoLive(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  fromPaths: readonly string[],
): Promise<
  { readonly ok: true; readonly card: string } | { readonly ok: false; readonly why: string }
> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.propose_go_live", {
    fromPaths: [...fromPaths],
  });
  if (!r.ok) return { ok: false, why: describeError(r.error) };
  const v = r.value as { proposalId: string; preview: { summary?: string } };
  return {
    ok: true,
    card:
      `Queued proposal ${v.proposalId}: ${v.preview.summary ?? "go live now"}. ` +
      `Approve it on the proposal card in this chat (queue: ${REDIRECT_PROPOSAL_QUEUE}); approving needs the Publish live permission. Until then the changes stay Staged — do not say they are live.`,
  };
}
