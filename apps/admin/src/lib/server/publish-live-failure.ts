// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1591 — the form answer of a Publish live (`deploy.promote`) that
 * did not go through, the same on every surface that publishes (Settings →
 * Deployments, the editor's Publish live, the pages list).
 *
 * A refusal — nothing staged ("run Stage first"), a closed quality gate
 * (#553, its `render` and `links` states included), a plugin that does not
 * run, a busy live release — is the operator's to act on: a 409 whose text
 * is the op's reason with its next step. Anything else broke on the server
 * side (the hosting, the publisher, recording the run) and stays a 500, but
 * with its reason too: an Owner must be able to tell an empty staging from a
 * closed gate from a fault. Settings → Deployments used to answer every
 * case with a bare "Promote staging → production failed.".
 */

import { describeError } from "@caelo-cms/admin-core";
import { failureKindOf } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";

/** Failure kinds the caller fixes by changing the call or its timing. */
const CALLER_FIXABLE: ReadonlySet<string> = new Set([
  "ValidationFailed",
  "ActorScopeRejected",
  "Conflict",
]);

/**
 * Whether a failed Publish live said no on purpose: a guard refusal
 * (`HandlerError.refusal`, #1091), a conflict, or a call that was not
 * acceptable as made.
 */
export function isPublishRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { kind?: unknown; refusal?: unknown };
  return (
    (e.kind === "HandlerError" && e.refusal === true) || CALLER_FIXABLE.has(failureKindOf(error))
  );
}

/**
 * The status and text of a failed Publish live.
 *
 * @param action - what the operator clicked, as the message starts
 *   ("Publish live", "Promote staging → production").
 */
export function publishLiveFailureText(
  action: string,
  error: unknown,
): { status: 409 | 500; error: string } {
  const refused = isPublishRefusal(error);
  return {
    status: refused ? 409 : 500,
    error: `${action} ${refused ? "refused" : "failed"}: ${describeError(error)}`,
  };
}

/** {@link publishLiveFailureText} as the action's `fail()` answer. */
export function publishLiveFailure(action: string, error: unknown) {
  const { status, error: text } = publishLiveFailureText(action, error);
  return fail(status, { error: text });
}
