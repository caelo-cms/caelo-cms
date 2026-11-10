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
 * What a Go live now did: live in Caelo — `notOnHosting` says which hosting
 * pushes did not land yet, null when every target took the table — or
 * refused.
 */
export type GoLiveNowOutcome =
  | { readonly live: true; readonly notOnHosting: string | null }
  | { readonly live: false; readonly refused: string };

/**
 * Go live now for `fromPaths` as the signed-in human. `changes` (id and
 * revision) binds it to what a save or an approval just wrote: a save in
 * between refuses it.
 */
export async function goLiveNow(
  locals: App.Locals,
  fromPaths: readonly string[],
  changes?: readonly { id: string; revision: number }[],
): Promise<GoLiveNowOutcome> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "redirects.go_live_now", {
    fromPaths: [...fromPaths],
    // The op takes exactly id and revision; a saved change carries its path too.
    ...(changes ? { changes: changes.map(({ id, revision }) => ({ id, revision })) } : {}),
  });
  if (!r.ok) return { live: false, refused: messageOf(r.error, "Go live now failed") };
  return { live: true, notOnHosting: hostingNotUpdated(r.value) };
}

/**
 * Which hosting targets of a Go live now result do not serve the change
 * yet, as one sentence, or null when every target took the table: a push
 * that failed (retried automatically) or one queued behind a release that
 * holds the live site (its holder pushes when it finishes).
 */
function hostingNotUpdated(value: unknown): string | null {
  const targets = (
    value as { targets: { targetName: string; status: string; error: string | null }[] }
  ).targets;
  const named = (status: string) =>
    targets
      .filter((t) => t.status === status)
      .map((t) => (t.error ? `${t.targetName}: ${t.error}` : t.targetName))
      .join("; ");
  const failed = named("failed");
  const queued = named("queued");
  const parts = [
    failed ? `the push to your hosting failed and is retried automatically (${failed})` : null,
    queued ? `the push to your hosting waits for a release that is running (${queued})` : null,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join("; ");
}

/**
 * The form result of a Go live now that ran: `liveMessage`, or — when the
 * hosting does not serve it yet — that as a warning. The save or approval
 * stands (it is live in Caelo, and a chat card shows its proposal applied),
 * but visitors keep getting the previous rule until the push lands, so it
 * is never reported as "live on your site".
 */
export function goLiveResult(notOnHosting: string | null, liveMessage: string) {
  if (notOnHosting === null) return { ok: true as const, message: liveMessage };
  return {
    ok: true as const,
    warning: true as const,
    message: `It is live in Caelo, but ${notOnHosting}. Until it lands, visitors keep getting the previous rule.`,
  };
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
    return goLiveResult(hostingNotUpdated(r.value), "Approved: live on your site now.");
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
    changes: { fromPath: string; id: string; revision: number }[];
  };
  // Only the saved changes go live now: a rule already live as it is has
  // none, and asking for its path would refuse the whole batch.
  if (v.goLive === "now" && v.changes.length > 0) {
    const live = await goLiveNow(
      locals,
      v.changes.map((c) => c.fromPath),
      v.changes,
    );
    if (!live.live) {
      return fail(409, {
        error: `Approved and saved; it goes live with the next Publish live, but it could not go live now: ${live.refused}`,
      });
    }
    return goLiveResult(live.notOnHosting, v.nextStep);
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
