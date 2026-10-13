// SPDX-License-Identifier: MPL-2.0

/**
 * The OAuth callback of a step-up (epic #696): take the challenge back,
 * exchange Google's code server-side, check the ID token proves a fresh
 * sign-in by the right account, and record it on the session — or record
 * why not. Every outcome is audited (`step_up.record`).
 *
 * The network call to Google sits between two ops, never inside a
 * transaction (see release-check-worker.ts for why).
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, StepUpPurpose } from "@caelo-cms/shared";
import type { StepUpRedeemed } from "../../ops/step-up.js";
import { exchangeCode, verifyFreshSignIn } from "./google-oidc.js";

export type StepUpCompletion =
  | { readonly ok: true; readonly returnTo: string; readonly purpose: StepUpPurpose }
  | { readonly ok: false; readonly returnTo: string; readonly message: string };

const DEFAULT_RETURN = "/settings/updates";

function messageOf(error: unknown): string {
  const e = error as { message?: string; kind?: string };
  return e.message ?? e.kind ?? "unknown error";
}

/** Finish a step-up from Google's redirect (`code` + `state`, or `error`). */
export async function completeGoogleStepUp(args: {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  readonly ctx: ExecutionContext;
  readonly sessionHash: string;
  readonly state: string | null;
  readonly code: string | null;
  /** Google's `error` parameter (`access_denied` when the user cancelled). */
  readonly error: string | null;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
}): Promise<StepUpCompletion> {
  const { registry, adapter, ctx, sessionHash } = args;
  if (!args.state) {
    return { ok: false, returnTo: DEFAULT_RETURN, message: "Google sent no sign-in state back." };
  }
  const redeemed = await execute(registry, adapter, ctx, "step_up.redeem", {
    sessionHash,
    state: args.state,
  });
  if (!redeemed.ok) {
    return { ok: false, returnTo: DEFAULT_RETURN, message: messageOf(redeemed.error) };
  }
  const c = redeemed.value as StepUpRedeemed;
  // Recorded against the challenge just redeemed — never on claims alone.
  const record = async (outcome: unknown) =>
    execute(registry, adapter, ctx, "step_up.record", {
      sessionHash,
      challengeId: c.challengeId,
      outcome,
    });
  const failWith = async (reason: string): Promise<StepUpCompletion> => {
    const r = await record({ ok: false, reason: reason.slice(0, 1000) });
    return {
      ok: false,
      returnTo: c.returnTo,
      message: r.ok ? reason : messageOf(r.error),
    };
  };

  if (args.error || !args.code) {
    return failWith(
      args.error === "access_denied"
        ? "The Google sign-in was cancelled."
        : `Google did not complete the sign-in (${args.error ?? "no code"}).`,
    );
  }
  const token = await exchangeCode(args.fetch, {
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    code: args.code,
    codeVerifier: c.codeVerifier,
    redirectUri: c.redirectUri,
  });
  if (!token.ok) return failWith(token.reason);
  const now = args.now?.() ?? new Date();
  const verified = verifyFreshSignIn(token.value, {
    clientId: c.clientId,
    nonce: c.nonce,
    startedAtSec: Math.floor(new Date(c.startedAt).getTime() / 1000),
    nowSec: Math.floor(now.getTime() / 1000),
  });
  if (!verified.ok) return failWith(verified.reason);
  const recorded = await record({
    ok: true,
    email: verified.value.email,
    authTime: verified.value.authTime,
    nonce: verified.value.nonce,
  });
  if (!recorded.ok) {
    return { ok: false, returnTo: c.returnTo, message: messageOf(recorded.error) };
  }
  return { ok: true, returnTo: c.returnTo, purpose: c.purpose };
}
