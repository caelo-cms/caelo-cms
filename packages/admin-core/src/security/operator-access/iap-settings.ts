// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #914 — the admin IAP resource's `oauthSettings`: which OAuth client
 * IAP signs people in with in the browser (`clientId` / `clientSecret`) and
 * whose Google tokens it accepts in `Authorization: Bearer`
 * (`programmaticClients`). One client, the install's Google sign-in client,
 * serves all of it plus the remote-MCP broker (#806).
 *
 * Without a configured client IAP uses its Google-managed OAuth client,
 * which admits only accounts of the project's own Google organisation —
 * the reason a gmail.com user with `roles/iap.httpsResourceAccessor` still
 * saw "You don't have access" (#914). With one, any Google account the IAM
 * binding names gets in.
 *
 * The operator-access sync job keeps all three fields at EXACTLY the
 * configured client, or clears all three when none is configured; a value
 * set by hand is replaced and logged, the same "exactly this" rule the job
 * applies to the IAP accessor role.
 *
 * API (cloud.google.com/iap/docs/reference/rest/v1/IapSettings, checked
 * 2026-10-20): `OAuthSettings` sits at `accessSettings.oauthSettings` with
 * `clientId`, `clientSecret` (input only), `clientSecretSha256` (output
 * only), `loginHint` and `programmaticClients`. `GET|PATCH
 * https://iap.googleapis.com/v1/<resource>:iapSettings`, resource
 * `projects/<number>/iap_web/cloud_run-<region>/services/<svc>` (Cloud Run
 * native IAP) or `projects/<number>/iap_web/compute/services/<backend>`
 * (load-balancer IAP).
 *
 * The PATCH's update mask is the whole `oauthSettings` message
 * ({@link OAUTH_SETTINGS_MASK}): a message path replaces the sub-message
 * (the API documents the same form for `reauthSettings`), so setting and
 * clearing are one shape and no other IAP setting is touched. Google's
 * custom-OAuth guide spells the leaf paths `oauthClientId` /
 * `oauthClientSecret`, names the resource does not have; the message path
 * sidesteps that ambiguity. `loginHint` is not ours and is carried over.
 */

import { createHash } from "node:crypto";
import { type GoogleDeps, googleCall } from "./google-iam.js";

/** Field mask of {@link reconcileOAuthSettings}' PATCH: the whole `oauthSettings` message. */
export const OAUTH_SETTINGS_MASK = "iapSettings.accessSettings.oauthSettings";

/** `oauthSettings` as IAP returns it (output fields included). */
export interface LiveOAuthSettings {
  readonly clientId?: string;
  readonly clientSecretSha256?: string;
  readonly loginHint?: string;
  readonly programmaticClients?: readonly string[];
}

interface IapSettings {
  readonly name?: string;
  readonly accessSettings?: { readonly oauthSettings?: LiveOAuthSettings };
}

/** The client IAP should use, or null for "none" (IAP's Google-managed client). */
export type DesiredOAuthClient = {
  readonly clientId: string;
  readonly clientSecret: string;
} | null;

/** The parts of `oauthSettings` the job owns, before and after a reconcile. */
export interface OAuthSettingsState {
  readonly clientId: string | null;
  readonly programmaticClients: readonly string[];
}

export interface OAuthSettingsReconciled {
  readonly before: OAuthSettingsState;
  readonly after: OAuthSettingsState;
  /** Whether a PATCH was sent. */
  readonly changed: boolean;
  /**
   * Why the PATCH was sent although the client ID and programmatic clients
   * already matched: IAP holds a different secret, or did not report a hash
   * to compare against (then the secret is re-applied every run).
   */
  readonly secretReason?: "differs" | "unverifiable";
}

/** Whether two client lists hold exactly the same entries (order-insensitive, no duplicates). */
export function sameClients(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

/**
 * Whether `reported` (IAP's `clientSecretSha256`) is the SHA-256 of
 * `secret`. The API does not document the encoding, so both hex (any case)
 * and base64 / base64url are accepted.
 */
export function secretHashMatches(reported: string, secret: string): boolean {
  const digest = createHash("sha256").update(secret, "utf8").digest();
  const value = reported.trim();
  const strip = (s: string) => s.replace(/=+$/, "");
  return (
    value.toLowerCase() === digest.toString("hex") ||
    strip(value) === strip(digest.toString("base64")) ||
    strip(value) === strip(digest.toString("base64url"))
  );
}

/**
 * Compare IAP's current `oauthSettings` with what the job wants. `inSync`
 * false means a PATCH is due; `secretReason` says when only the secret is.
 */
export function compareOAuthSettings(
  live: LiveOAuthSettings,
  desired: DesiredOAuthClient,
): { readonly inSync: boolean; readonly secretReason?: "differs" | "unverifiable" } {
  const programmatic = [...(live.programmaticClients ?? [])];
  if (!desired) {
    return {
      inSync: !live.clientId && !live.clientSecretSha256 && programmatic.length === 0,
    };
  }
  if (live.clientId !== desired.clientId || !sameClients(programmatic, [desired.clientId])) {
    return { inSync: false };
  }
  if (!live.clientSecretSha256) return { inSync: false, secretReason: "unverifiable" };
  return secretHashMatches(live.clientSecretSha256, desired.clientSecret)
    ? { inSync: true }
    : { inSync: false, secretReason: "differs" };
}

/** The `oauthSettings` body that makes IAP use `desired` (or nothing), keeping `loginHint`. */
export function oauthSettingsBody(
  live: LiveOAuthSettings,
  desired: DesiredOAuthClient,
): Record<string, unknown> {
  return {
    ...(live.loginHint ? { loginHint: live.loginHint } : {}),
    ...(desired
      ? {
          clientId: desired.clientId,
          clientSecret: desired.clientSecret,
          programmaticClients: [desired.clientId],
        }
      : {}),
  };
}

/**
 * Make `oauthSettings` on the IAP resource at `resourceUrl` (an
 * `https://iap.googleapis.com/v1/projects/<n>/iap_web/...` URL without a
 * suffix) use exactly `desired` — browser client, its secret and the
 * programmatic client list — or none of them. Throws `GoogleCallError` on a
 * failed call. The secret never appears in the return value.
 */
export async function reconcileOAuthSettings(
  deps: GoogleDeps,
  resourceUrl: string,
  desired: DesiredOAuthClient,
): Promise<OAuthSettingsReconciled> {
  const settings = (await googleCall(deps, `${resourceUrl}:iapSettings`, "GET")) as IapSettings;
  const live = settings.accessSettings?.oauthSettings ?? {};
  const before: OAuthSettingsState = {
    clientId: live.clientId ?? null,
    programmaticClients: [...(live.programmaticClients ?? [])],
  };
  const after: OAuthSettingsState = desired
    ? { clientId: desired.clientId, programmaticClients: [desired.clientId] }
    : { clientId: null, programmaticClients: [] };
  const compared = compareOAuthSettings(live, desired);
  if (compared.inSync) return { before, after: before, changed: false };
  const name = resourceUrl.replace(/^https:\/\/iap\.googleapis\.com\/v1\//, "");
  await googleCall(
    deps,
    `${resourceUrl}:iapSettings?updateMask=${encodeURIComponent(OAUTH_SETTINGS_MASK)}`,
    "PATCH",
    { name, accessSettings: { oauthSettings: oauthSettingsBody(live, desired) } },
  );
  return {
    before,
    after,
    changed: true,
    ...(compared.secretReason ? { secretReason: compared.secretReason } : {}),
  };
}
