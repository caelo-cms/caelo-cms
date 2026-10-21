// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #914 — IAP's `oauthSettings`: which OAuth client IAP signs people
 * in with in the browser (`clientId` / `clientSecret`) and whose Google
 * tokens it accepts in `Authorization: Bearer` (`programmaticClients`). One
 * client, the install's Google sign-in client, serves all of it plus the
 * remote-MCP broker (#806).
 *
 * Without a configured client IAP uses its Google-managed OAuth client,
 * which admits only accounts of the project's own Google organisation —
 * the reason a gmail.com user with `roles/iap.httpsResourceAccessor` still
 * saw "You don't have access" (#914). With one, any Google account the IAM
 * binding names gets in.
 *
 * WHERE the client is set: the PROJECT's IAP settings (`projects/<number>`),
 * not the admin's IAP resource. Google documents a custom OAuth client for
 * IAP on Cloud Run only at project or organisation level
 * (docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run,
 * "Apply the OAuth client to IAP": "You can apply the OAuth client at the
 * project or organization level", `gcloud iap settings set … --project`),
 * and programmatic clients only at organisation, folder or project level
 * (docs.cloud.google.com/iap/docs/sharing-oauth-clients). (The HTTP 400
 * first seen on viu-one-web on 2026-10-21 came from the update mask, not the
 * level; see the mask note below.) Settings inherit down the IAP
 * hierarchy (project → iap_web → service type → service;
 * docs.cloud.google.com/iap/docs/customizing), so the project value reaches
 * the admin's resource on both providers (Cloud Run IAP on gcp-firebase,
 * the load balancer's backend service on gcp) — unless the resource sets
 * `oauthSettings` itself, which would override it. The job therefore keeps
 * the project at the client and the admin's resource free of one of its own
 * (sync-job.ts).
 *
 * The operator-access sync job keeps all three fields at EXACTLY the
 * configured client, or clears all three when none is configured; a value
 * set by hand is replaced and logged, the same "exactly this" rule the job
 * applies to the IAP accessor role.
 *
 * API (docs.cloud.google.com/iap/docs/reference/rest/v1/IapSettings, checked
 * 2026-10-21): `OAuthSettings` sits at `accessSettings.oauthSettings` with
 * `clientId`, `clientSecret` (input only), `clientSecretSha256` (output
 * only), `loginHint` and `programmaticClients`. `GET|PATCH
 * https://iap.googleapis.com/v1/<resource>:iapSettings`, resource
 * `projects/<number>` (what `gcloud iap settings get --project` calls),
 * `projects/<number>/iap_web/cloud_run-<region>/services/<svc>` (Cloud Run
 * native IAP) or `projects/<number>/iap_web/compute/services/<backend>`
 * (load-balancer IAP). IAM: `iap.projects.getSettings` /
 * `iap.projects.updateSettings` on the project level,
 * `iap.webServices.getSettings` / `updateSettings` on a service (both in
 * `roles/iap.settingsAdmin`).
 *
 * The PATCH's update mask names the three fields the job owns, leaf by
 * leaf ({@link OAUTH_SETTINGS_MASK}). IAP refuses a mask on the whole
 * `oauthSettings` message with HTTP 400 INVALID_ARGUMENT, even with an empty
 * body, at project and at service level; the same body under the leaf
 * masks is accepted (probed live on viu-one-web, 2026-10-21). A leaf in the
 * mask that is absent from the body is cleared, so setting and clearing are
 * one shape. `loginHint` is not ours: it stays out of the mask and is left
 * as it is.
 */

import { createHash } from "node:crypto";
import { type GoogleDeps, googleCall } from "./google-iam.js";

/** Field mask of {@link reconcileOAuthSettings}' PATCH: the three `oauthSettings` leaves the job owns. */
export const OAUTH_SETTINGS_MASK = [
  "iapSettings.accessSettings.oauthSettings.clientId",
  "iapSettings.accessSettings.oauthSettings.clientSecret",
  "iapSettings.accessSettings.oauthSettings.programmaticClients",
].join(",");

/**
 * The project-level IAP settings resource (`projects/<number>`, without the
 * `:iapSettings` suffix) — where the job sets the Google sign-in client.
 * IAP resource names use the project NUMBER.
 */
export function iapProjectResourceUrl(projectNumber: string): string {
  return `https://iap.googleapis.com/v1/projects/${projectNumber}`;
}

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
  const strip = (s: string) => {
    let end = s.length;
    while (end > 0 && s[end - 1] === "=") end -= 1;
    return s.slice(0, end);
  };
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

/**
 * The `oauthSettings` body that makes IAP use `desired`, or `{}` to clear
 * the three masked fields. `loginHint` is outside the mask and never sent.
 */
export function oauthSettingsBody(desired: DesiredOAuthClient): Record<string, unknown> {
  return desired
    ? {
        clientId: desired.clientId,
        clientSecret: desired.clientSecret,
        programmaticClients: [desired.clientId],
      }
    : {};
}

/**
 * Make `oauthSettings` on the IAP settings resource at `resourceUrl` (an
 * `https://iap.googleapis.com/v1/projects/<n>[/iap_web/...]` URL without
 * the `:iapSettings` suffix; {@link iapProjectResourceUrl} for the
 * project) use exactly `desired` — browser client, its secret and the
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
    { name, accessSettings: { oauthSettings: oauthSettingsBody(desired) } },
  );
  return {
    before,
    after,
    changed: true,
    ...(compared.secretReason ? { secretReason: compared.secretReason } : {}),
  };
}
