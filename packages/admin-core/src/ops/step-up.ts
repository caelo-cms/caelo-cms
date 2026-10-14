// SPDX-License-Identifier: MPL-2.0

/**
 * Step-up re-authentication with the Caelo password (epic #696 decision 4,
 * revised by #757). See security/step-up/gate.ts for how guarded ops use the
 * result.
 *
 *   step_up.confirm_password   the caller re-enters their password; a right
 *                              one records a step-up for one action on this
 *                              session, a wrong one counts towards
 *                              {@link STEP_UP_MAX_FAILURES}, at which the
 *                              session is signed out.
 *
 * Why the password and not a fresh Google sign-in: the admin already sits
 * behind IAP / the forward-auth proxy, so only allowlisted people reach it at
 * all. The step-up has to stop a bystander at an unlocked computer and a
 * stolen session cookie, and the password does both — without the Google
 * OAuth client the Owner had to create by hand per install. Browser autofill
 * is the known gap; passkeys replace the password in #725.
 *
 * Human-only: a step-up proves a person is at the browser, so neither the
 * AI nor a system worker can make one.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, STEP_UP_MAX_AGE_SECONDS, STEP_UP_PURPOSES } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAuditFromCtx } from "../audit.js";
import { MAX_PASSWORD_LENGTH, verifyPassword } from "../password.js";
import { readSessionStepUp, sessionHashSchema } from "../security/step-up/gate.js";
import { missingPermissions } from "./_approver-permission.js";

/**
 * Wrong passwords a session may enter for step-ups before it is signed out.
 * Without a bound, a stolen session cookie would turn this op into an
 * unlimited password oracle; signing out sends the thief back through IAP
 * and the login form.
 */
export const STEP_UP_MAX_FAILURES = 5;

/** Message prefix when the session was signed out: the route clears the cookie. */
export const STEP_UP_SIGNED_OUT = "step_up_signed_out";

const handlerError = (operation: string, message: string) =>
  err({ kind: "HandlerError" as const, operation, message });

export const stepUpConfirmPasswordOp = defineOperation({
  name: "step_up.confirm_password",
  // Why human-only: proves a person is at the caller's own browser right
  // now; the AI and workers have no password and no browser session.
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      sessionHash: sessionHashSchema,
      /** The action the confirmation authorizes (one of it). */
      purpose: z.enum(STEP_UP_PURPOSES),
      password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    })
    .strict(),
  output: z.object({ freshUntil: z.string() }),
  handler: async (ctx, input, tx) => {
    const op = "step_up.confirm_password";
    const missing = await missingPermissions(tx, ctx.actorId, ["platform.update"]);
    if (missing.length > 0) {
      return handlerError(
        op,
        "permission_denied: only someone with the platform.update permission (the Owner) can confirm update actions.",
      );
    }
    // Locked: two wrong passwords racing must both count.
    const session = await readSessionStepUp(tx, ctx.actorId, input.sessionHash, { lock: true });
    if (!session) return handlerError(op, "this browser session is not signed in any more");
    const rows = (await tx.execute(sql`
      SELECT password_hash FROM users WHERE id = ${ctx.actorId}::uuid AND deleted_at IS NULL
    `)) as unknown as { password_hash: string }[];
    const hash = rows[0]?.password_hash;
    const passwordOk = hash ? await verifyPassword(input.password, hash) : false;
    const bySession = sql`encode(sha256(convert_to(token, 'UTF8')), 'hex') = ${input.sessionHash}
       AND user_id = ${ctx.actorId}::uuid`;

    if (!passwordOk) {
      const failures = session.stepUpFailures + 1;
      const signedOut = failures >= STEP_UP_MAX_FAILURES;
      // A wrong password also drops any confirmation still on the session:
      // whoever is typing now is not known to be the Owner.
      if (signedOut) {
        await tx.execute(sql`DELETE FROM sessions WHERE ${bySession}`);
      } else {
        await tx.execute(sql`
          UPDATE sessions
             SET step_up_failures = ${failures}, step_up_at = NULL, step_up_purpose = NULL
           WHERE ${bySession}
        `);
      }
      // Returning the error (not throwing) commits the count and this audit
      // row — a rollback would erase both (query-api OperationAbortError).
      await recordAuditFromCtx(tx, ctx, {
        operation: op,
        input: { purpose: input.purpose },
        succeeded: false,
        resultSummary: signedOut
          ? `wrong password ${failures}x — session signed out`
          : `wrong password (${failures}/${STEP_UP_MAX_FAILURES})`,
      });
      const left = STEP_UP_MAX_FAILURES - failures;
      return handlerError(
        op,
        signedOut
          ? `${STEP_UP_SIGNED_OUT}: Wrong password ${STEP_UP_MAX_FAILURES} times — you have been signed out. Sign in again to continue.`
          : `Wrong password. ${left} more ${left === 1 ? "try" : "tries"} before you are signed out.`,
      );
    }

    const confirmed = (await tx.execute(sql`
      UPDATE sessions
         SET step_up_at = now(), step_up_purpose = ${input.purpose}, step_up_failures = 0
       WHERE ${bySession}
       RETURNING step_up_at
    `)) as unknown as { step_up_at: Date | string }[];
    const at = new Date(confirmed[0]?.step_up_at ?? Date.now());
    await recordAuditFromCtx(tx, ctx, {
      operation: op,
      input: { purpose: input.purpose },
      succeeded: true,
      resultSummary: `password confirmed for ${input.purpose}`,
    });
    return ok({
      freshUntil: new Date(at.getTime() + STEP_UP_MAX_AGE_SECONDS * 1000).toISOString(),
    });
  },
});
