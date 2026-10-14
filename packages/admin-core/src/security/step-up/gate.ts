// SPDX-License-Identifier: MPL-2.0

/**
 * The step-up gate inside the ops it protects (epic #696 decision 4, revised
 * by #757): installing a Caelo release and changing the update policy need
 * the Owner's permission AND their password, re-entered from the same
 * browser session moments ago (`step_up.confirm_password`).
 *
 * The routes confirm the password first, but the op is the trust boundary:
 * every guarded op calls {@link guardedActionRefusal} in its handler and
 * {@link consumeStepUp} once it acted, so one confirmation authorizes exactly
 * one action — the same "each instance gets its own click" rule as
 * CLAUDE.md §11.A.
 *
 * Sessions are named by the sha256 of their cookie token (`sessionHash`),
 * never the token itself: op inputs travel through validation errors and
 * the audit hash.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  STEP_UP_MAX_AGE_SECONDS,
  type StepUpPurpose,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { missingPermissions } from "../../ops/_approver-permission.js";
import type { Permission } from "../../permissions.js";

/** Message prefix of a refusal the UI answers by asking for the password. */
export const STEP_UP_REQUIRED = "step_up_required";

/** Op input field naming the caller's session: sha256 hex of its cookie token. */
export const sessionHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected the sha256 hex of the session token");

/** The sha256 hex of a session cookie token (what ops take as `sessionHash`). */
export async function sessionHashOf(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The step-up state of one session, or null when the session is not the caller's. */
export interface SessionStepUp {
  /** When the password was last confirmed in this session, unconsumed. */
  readonly stepUpAt: Date | null;
  /** What the confirmation was for. */
  readonly stepUpPurpose: string | null;
  /** Wrong passwords entered for a step-up since the last right one. */
  readonly stepUpFailures: number;
}

/** Read the caller's own live session named by `sessionHash`. */
export async function readSessionStepUp(
  tx: TransactionRunner,
  actorId: string,
  sessionHash: string,
  opts: { readonly lock?: boolean } = {},
): Promise<SessionStepUp | null> {
  // A guarded action locks the session row until its transaction ends, so a
  // second action racing on the same step-up waits and then finds it
  // consumed — one confirmation, one action.
  const rows = (await tx.execute(sql`
    SELECT s.step_up_at, s.step_up_purpose, s.step_up_failures
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE encode(sha256(convert_to(s.token, 'UTF8')), 'hex') = ${sessionHash}
       AND s.user_id = ${actorId}::uuid
       AND s.expires_at > now()
       AND u.deleted_at IS NULL
     LIMIT 1
     ${opts.lock ? sql`FOR UPDATE OF s` : sql``}
  `)) as unknown as {
    step_up_at: Date | string | null;
    step_up_purpose: string | null;
    step_up_failures: number;
  }[];
  const r = rows[0];
  if (!r) return null;
  return {
    stepUpAt: r.step_up_at === null ? null : new Date(r.step_up_at),
    stepUpPurpose: r.step_up_purpose,
    stepUpFailures: Number(r.step_up_failures),
  };
}

/**
 * Why the step-up of `session` does not authorize an action now, or null
 * when it does: a password confirmation for `purpose` within `maxAgeSec`.
 */
function stepUpProblem(
  session: SessionStepUp | null,
  now: Date,
  purpose: StepUpPurpose | null,
  maxAgeSec: number = STEP_UP_MAX_AGE_SECONDS,
): string | null {
  if (!session) return "this browser session is not signed in any more";
  if (!session.stepUpAt) return "your password has not confirmed this action yet";
  if (purpose && session.stepUpPurpose !== purpose) {
    return "the password was confirmed for a different action";
  }
  const ageSec = Math.floor((now.getTime() - session.stepUpAt.getTime()) / 1000);
  if (ageSec > maxAgeSec) {
    return `the password was confirmed ${ageSec} seconds ago; a confirmation is valid for ${maxAgeSec} seconds`;
  }
  return null;
}

/**
 * Whether `ctx` may run the guarded action `operation` with the step-up of
 * `sessionHash`: a human holding `permission` whose session carries a fresh
 * password confirmation. Returns the refusal message, or null.
 */
export async function guardedActionRefusal(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  opts: {
    readonly operation: string;
    readonly permission: Permission;
    readonly sessionHash: string;
    /** The action the password must have been confirmed for. */
    readonly purpose: StepUpPurpose;
    readonly now?: Date;
  },
): Promise<string | null> {
  if (ctx.actorKind !== "human") {
    return `permission_denied: only the Owner can ${opts.operation}, never ${ctx.actorKind === "ai" ? "the AI" : `a ${ctx.actorKind} actor`}.`;
  }
  const missing = await missingPermissions(tx, ctx.actorId, [opts.permission]);
  if (missing.length > 0) {
    return `permission_denied: this needs the ${opts.permission} permission (the Owner has it); your role does not.`;
  }
  const session = await readSessionStepUp(tx, ctx.actorId, opts.sessionHash, { lock: true });
  const problem = stepUpProblem(session, opts.now ?? new Date(), opts.purpose);
  if (problem) {
    return `${STEP_UP_REQUIRED}: ${problem}. Enter your password to confirm, then try again.`;
  }
  return null;
}

/** Use up the session's step-up: the next guarded action needs the password again. */
export async function consumeStepUp(
  tx: TransactionRunner,
  actorId: string,
  sessionHash: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE sessions SET step_up_at = NULL, step_up_purpose = NULL
     WHERE encode(sha256(convert_to(token, 'UTF8')), 'hex') = ${sessionHash}
       AND user_id = ${actorId}::uuid
  `);
}
