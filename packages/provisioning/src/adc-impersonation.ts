// SPDX-License-Identifier: MPL-2.0

/**
 * Pre-flight for the keyless provisioner's credential chain (#696): before
 * `pulumi up`, verify that the operator's Application Default Credentials
 * exist and may mint a token for `caelo-provisioner` — the exact chain
 * Pulumi's GCP provider uses (wizards/gcp-pulumi.ts `pulumiGcpEnv`). A
 * missing login or grant then fails here with the fix, not halfway through
 * the stack. See provisioner-identity.ts for the design.
 *
 * Both access tokens involved (the ADC source token and the minted one)
 * stay in local variables: never printed, logged, returned or written.
 */

import { gcloud as defaultGcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep, type Sleep } from "./gcloud-retry.js";
import {
  operatorMember,
  PROPAGATION_DELAYS_MS,
  provisionerServiceAccountEmail,
  TOKEN_CREATOR_ROLE,
  withoutAmbientGoogleCredentials,
} from "./provisioner-identity.js";

export type AdcCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `no-adc`: no Application Default Credentials; `denied`: they can't impersonate. */
      readonly reason: "no-adc" | "denied" | "error";
      readonly error: string;
    };

/**
 * Verify the credential chain Pulumi will use: the operator's Application
 * Default Credentials exist and may mint a token for the provisioner. Run
 * before `pulumi up` so a missing login or grant fails here with the fix,
 * not halfway through the stack. `freshGrant` waits out IAM propagation
 * (a new binding can take minutes to apply). Both tokens stay in this
 * function: neither is printed nor kept.
 */
export async function checkAdcImpersonation(
  target: { readonly projectId: string; readonly operatorAccount: string; freshGrant: boolean },
  deps: { run?: GcloudRunner; sleep?: Sleep; fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<AdcCheck> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const doFetch = deps.fetch ?? fetch;
  const sa = provisionerServiceAccountEmail(target.projectId);
  const env = withoutAmbientGoogleCredentials(deps.env ?? process.env);

  const adc = await run(["auth", "application-default", "print-access-token"], { env });
  const sourceToken = adc.ok ? adc.stdout.trim() : "";
  if (!sourceToken) {
    return {
      ok: false,
      reason: "no-adc",
      error: [
        "No Application Default Credentials on this machine.",
        `Infrastructure runs authenticate with your own Google login and impersonate ${sa}; no key file is used.`,
        `Run \`gcloud auth application-default login\` (sign in as ${target.operatorAccount}), then re-run.`,
      ].join("\n"),
    };
  }

  const delays = target.freshGrant ? PROPAGATION_DELAYS_MS : [];
  let status = 0;
  let detail = "";
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await doFetch(
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:generateAccessToken`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${sourceToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            scope: ["https://www.googleapis.com/auth/cloud-platform"],
            lifetime: "300s",
          }),
        },
      );
      status = res.status;
      // Drain the body without keeping the minted token; only the error text matters.
      const text = await res.text();
      if (res.ok) return { ok: true };
      detail = errorMessage(text);
    } catch (e) {
      return {
        ok: false,
        reason: "error",
        error: `Could not reach the IAM Credentials API: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const delay = delays[attempt];
    if (status !== 403 || delay === undefined) break;
    await sleep(delay);
  }

  if (status !== 403) {
    return {
      ok: false,
      reason: "error",
      error: `Impersonating ${sa} failed (HTTP ${status}): ${detail}`,
    };
  }
  const adcAccount = await tokenAccount(doFetch, sourceToken);
  const mismatch =
    adcAccount && adcAccount.toLowerCase() !== target.operatorAccount.trim().toLowerCase();
  return {
    ok: false,
    reason: "denied",
    error: [
      `Your Application Default Credentials${adcAccount ? ` (${adcAccount})` : ""} may not impersonate ${sa}: ${detail}`,
      mismatch
        ? `They belong to another account than gcloud (${target.operatorAccount}), which holds ${TOKEN_CREATOR_ROLE} on it. Run \`gcloud auth application-default login\` as ${target.operatorAccount}, then re-run.`
        : `The account needs ${TOKEN_CREATOR_ROLE} on ${sa}. A grant made moments ago can take a few minutes to apply: wait, then re-run. Otherwise ask a project Owner to run:\n  gcloud iam service-accounts add-iam-policy-binding ${sa} --project=${target.projectId} --member=${operatorMember(adcAccount || target.operatorAccount)} --role=${TOKEN_CREATOR_ROLE} --condition=None`,
    ].join("\n"),
  };
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON — fall through to the raw text
  }
  return body.trim().slice(0, 300) || "(no body)";
}

/** The email an access token belongs to (Google's tokeninfo), or "" when unknown. */
async function tokenAccount(doFetch: typeof fetch, accessToken: string): Promise<string> {
  try {
    const res = await doFetch("https://oauth2.googleapis.com/tokeninfo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: accessToken }).toString(),
    });
    if (!res.ok) return "";
    const info = (await res.json()) as { email?: unknown };
    return typeof info.email === "string" ? info.email : "";
  } catch {
    return "";
  }
}
