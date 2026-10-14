// SPDX-License-Identifier: MPL-2.0

/**
 * Step-up for the admin's guarded actions (epic #696 decision 4, revised by
 * #757): installing a Caelo update and changing the update policy need the
 * Owner's password, re-entered in the same form that runs the action.
 * {@link confirmStepUp} records the confirmation on the session; the action's
 * op then checks it again (admin-core security/step-up/gate.ts) and consumes
 * it, so the route is not the only line.
 */

import { STEP_UP_SIGNED_OUT, sessionHashOf } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import type { StepUpPurpose } from "@caelo-cms/shared";
import { type ActionFailure, type Cookies, fail, redirect } from "@sveltejs/kit";
import { SESSION_COOKIE } from "./guards.js";
import { opErrorMessage } from "./op-error.js";
import { getQueryContext } from "./query.js";

/** The caller's session as guarded ops name it (sha256 of the cookie token). */
export async function sessionHashFrom(cookies: Cookies): Promise<string | null> {
  const token = cookies.get(SESSION_COOKIE);
  return token ? sessionHashOf(token) : null;
}

/** What a form needs back when the confirmation failed. */
export interface StepUpFailure {
  readonly error: string;
  readonly stepUpRequired: true;
  /** The form action, so the page reopens that action's password dialog. */
  readonly action: string;
  /** A policy action: the page shows the error in the policy card. */
  readonly policy?: true;
}

/**
 * Confirm the form's `password` for one `purpose` action on this session
 * (`action` names the form action, for the page to reopen its dialog).
 * Returns the session hash the action's op takes, or the form failure to
 * return. Five wrong passwords sign the session out; this then clears the
 * cookie and sends the browser to the login.
 */
export async function confirmStepUp(
  locals: App.Locals,
  cookies: Cookies,
  form: FormData,
  purpose: StepUpPurpose,
  action: string,
): Promise<
  { ok: true; sessionHash: string } | { ok: false; failure: ActionFailure<StepUpFailure> }
> {
  const extra = { action, ...(purpose === "update_policy" ? { policy: true as const } : {}) };
  const sessionHash = await sessionHashFrom(cookies);
  if (!sessionHash) throw redirect(303, "/login");
  const password = String(form.get("password") ?? "");
  if (!password) {
    return {
      ok: false,
      failure: fail(400, {
        error: "Enter your password to confirm.",
        stepUpRequired: true,
        ...extra,
      }),
    };
  }
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "step_up.confirm_password", {
    sessionHash,
    purpose,
    password,
  });
  if (r.ok) return { ok: true, sessionHash };
  const message = opErrorMessage(r.error, "could not check the password");
  if (message.startsWith(STEP_UP_SIGNED_OUT)) {
    cookies.delete(SESSION_COOKIE, { path: "/" });
    throw redirect(303, "/login");
  }
  return { ok: false, failure: fail(403, { error: message, stepUpRequired: true, ...extra }) };
}
