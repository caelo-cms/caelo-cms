// SPDX-License-Identifier: MPL-2.0

/**
 * The decisions on redirect proposals (CLAUDE.md §11.A), shared by Settings
 * → Redirects and the queue URL the AI's cards name
 * (`/settings/redirects/pending`):
 *
 * - #1358 — a target on another domain (`redirects.execute_proposal`,
 *   `settings.write`; "now" also needs the Publish live permission and goes
 *   live right after the approval commits);
 * - #1550 — the AI's Go live now (`redirects.execute_go_live`, the Publish
 *   live permission), run as the approver.
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requireApproverPermission, requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";

/** A proposal waiting on Settings → Redirects. */
export interface RedirectProposal {
  readonly id: string;
  readonly kind: "set_external" | "go_live_now";
  readonly payload: {
    readonly redirects?: readonly { fromPath: string; url: string; statusCode: number }[];
    readonly fromPaths?: readonly string[];
    readonly goLive?: "next_publish" | "now";
  };
  readonly preview: { readonly summary?: string };
}

/** The message of an op error, or `fallback`. */
export function messageOf(error: unknown, fallback: string): string {
  return typeof error === "object" && error && "message" in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

/**
 * Go live now for `fromPaths` as the signed-in human. `changes` (id and
 * revision) binds it to what a save or an approval just wrote: a save in
 * between refuses it. Null when it went live (also when a push failed: it
 * is live in Caelo and retried, and the text says so); otherwise the
 * refusal's text.
 */
export async function goLiveNow(
  locals: App.Locals,
  fromPaths: string[],
  changes?: readonly { id: string; revision: number }[],
): Promise<string | null> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "redirects.go_live_now", {
    fromPaths,
    ...(changes ? { changes } : {}),
  });
  if (!r.ok) return messageOf(r.error, "Go live now failed");
  const failed = (
    r.value as { targets: { status: string; error: string | null }[] }
  ).targets.filter((t) => t.status === "failed");
  return failed.length === 0
    ? null
    : `It is live in Caelo, but the push to your hosting failed and is retried: ${failed.map((t) => t.error).join("; ")}`;
}

/** The pending redirect proposals. */
export async function listRedirectProposals(locals: App.Locals): Promise<RedirectProposal[]> {
  const { adapter, registry } = getQueryContext();
  const pending = await execute(registry, adapter, locals.ctx, "redirects.list_pending", {});
  if (!pending.ok) {
    throw new Error(`redirects.list_pending failed: ${JSON.stringify(pending.error)}`);
  }
  return (pending.value as { proposals: RedirectProposal[] }).proposals;
}

/**
 * The Approve form action, dispatched on the proposal's kind. The page
 * reads the form (and its `proposalId`, the field the chat card posts).
 */
export async function approveRedirectProposal(
  locals: App.Locals,
  form: FormData,
  proposalId: string,
) {
  await assertCsrfToken(form, locals);
  const { adapter, registry } = getQueryContext();
  const proposal = (await listRedirectProposals(locals)).find((p) => p.id === proposalId);
  if (!proposal) return fail(404, { error: "This proposal is no longer pending." });
  if (proposal.kind === "go_live_now") {
    requireApproverPermission(locals, registry, "redirects.execute_go_live");
    const r = await execute(registry, adapter, locals.ctx, "redirects.execute_go_live", {
      proposalId,
    });
    if (!r.ok) return fail(409, { error: messageOf(r.error, "approve failed") });
    return { ok: true, message: "Approved: live on your site now." };
  }
  requireApproverPermission(locals, registry, "redirects.execute_proposal");
  if (proposal.payload.goLive === "now") requirePermission(locals, "deploy.trigger");
  const r = await execute(registry, adapter, locals.ctx, "redirects.execute_proposal", {
    proposalId,
  });
  if (!r.ok) return fail(400, { error: messageOf(r.error, "approve failed") });
  const v = r.value as {
    nextStep: string;
    goLive: string;
    fromPaths: string[];
    changes: { id: string; revision: number }[];
  };
  if (v.goLive === "now" && v.changes.length > 0) {
    const refused = await goLiveNow(locals, v.fromPaths, v.changes);
    if (refused) {
      return fail(409, {
        error: `Approved and saved; it goes live with the next Publish live, but it could not go live now: ${refused}`,
      });
    }
  }
  return { ok: true, message: v.nextStep };
}

/** The Reject form action (the page reads the form, as for Approve). */
export async function rejectRedirectProposal(
  locals: App.Locals,
  form: FormData,
  proposalId: string,
) {
  requirePermission(locals, "content.write");
  await assertCsrfToken(form, locals);
  const { adapter, registry } = getQueryContext();
  const reason = String(form.get("reason") ?? "").trim();
  const r = await execute(registry, adapter, locals.ctx, "redirects.reject_proposal", {
    proposalId,
    ...(reason ? { reason } : {}),
  });
  if (!r.ok) return fail(400, { error: messageOf(r.error, "reject failed") });
  return { ok: true, message: "Proposal rejected." };
}
