// SPDX-License-Identifier: MPL-2.0

/**
 * Probe this machine's Application Default Credentials (#1078) — the
 * credentials every local Pulumi run uses (the installer in local mode,
 * `state migrate`). Without the probe, Pulumi starts with missing or
 * expired ADC and prints one provider error per resource (`invalid_grant`
 * … `invalid_rapt`) before failing, and the one line the Owner needs —
 * `gcloud auth application-default login` — never appears.
 *
 * The probe runs `gcloud auth application-default print-access-token`,
 * which refreshes the token exactly as Pulumi's Google provider would, so
 * expired or reauth-blocked credentials fail here. The token is discarded.
 */

import { type GcloudResult, gcloudErrorLine, isGcloudAuthError } from "./gcloud.js";

/** The command that fixes both a missing and an expired login. */
export const ADC_LOGIN_COMMAND = "gcloud auth application-default login";

export type AdcProbe =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `missing`: no ADC on this machine; `expired`: they exist but can no
       * longer mint a token (expired/revoked refresh token, reauth policy);
       * `error`: gcloud failed for another reason (its line is in `error`).
       */
      readonly reason: "missing" | "expired" | "error";
      /** One line naming {@link ADC_LOGIN_COMMAND}. */
      readonly error: string;
    };

/** gcloud's wording when no ADC file exists (and google-auth's, for older SDKs). */
const ADC_MISSING = /credentials were not found|could not automatically determine credentials/i;

/**
 * Classify the result of `gcloud auth application-default print-access-token`.
 * Pure, so the async installer path and the sync attach path word it alike.
 */
export function adcProbeFromResult(r: GcloudResult): AdcProbe {
  if (r.ok && r.stdout.trim().length > 0) return { ok: true };
  if (ADC_MISSING.test(r.stderr) || (r.ok && r.stdout.trim().length === 0)) {
    return {
      ok: false,
      reason: "missing",
      error: `No Application Default Credentials on this machine; Pulumi needs them. Run \`${ADC_LOGIN_COMMAND}\` and re-run this command.`,
    };
  }
  if (isGcloudAuthError(r.stderr)) {
    return {
      ok: false,
      reason: "expired",
      error: `The Application Default Credentials on this machine have expired (gcloud: ${gcloudErrorLine(r.stderr)}). Run \`${ADC_LOGIN_COMMAND}\` and re-run this command.`,
    };
  }
  return {
    ok: false,
    reason: "error",
    error: `Could not check the Application Default Credentials on this machine (gcloud: ${gcloudErrorLine(r.stderr)}). Run \`${ADC_LOGIN_COMMAND}\` if they are missing or expired, then re-run this command.`,
  };
}

/** The `print-access-token` arguments the probe runs. */
export const ADC_PROBE_ARGS: readonly string[] = [
  "auth",
  "application-default",
  "print-access-token",
];
