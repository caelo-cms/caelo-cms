// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — the admin IAP resource's `programmatic_clients`: the OAuth
 * clients whose Google tokens IAP accepts in `Authorization: Bearer` (the
 * remote-MCP broker hands MCP clients the user's own token of the client the
 * Owner configured). The operator-access sync job keeps the list at EXACTLY
 * the configured client, or empty when none is configured — an entry added
 * by hand, or a client the Owner replaced, is removed and logged, the same
 * "exactly this" rule the job applies to the IAP accessor role.
 *
 * API: `GET|PATCH https://iap.googleapis.com/v1/<resource>:iapSettings`
 * (iap.googleapis.com discovery, `getIapSettings` / `updateIapSettings`),
 * resource `projects/<number>/iap_web/cloud_run-<region>/services/<svc>`
 * (Cloud Run native IAP) or `projects/<number>/iap_web/compute/services/
 * <backend>` (load balancer IAP) — the same names gcloud's `iap settings`
 * builds. The PATCH carries an update mask so no other IAP setting (the
 * Google-managed browser login, reauth, CORS, …) is rewritten; without one
 * "it replaces all fields".
 */

import { type GoogleDeps, googleCall } from "./google-iam.js";

/** Field mask of {@link reconcileProgrammaticClients}' PATCH (request-relative, as the API documents its masks). */
export const PROGRAMMATIC_CLIENTS_MASK =
  "iapSettings.accessSettings.oauthSettings.programmaticClients";

interface IapSettings {
  readonly name?: string;
  readonly accessSettings?: {
    readonly oauthSettings?: { readonly programmaticClients?: readonly string[] };
  };
}

export interface ProgrammaticClientsReconciled {
  readonly before: readonly string[];
  readonly after: readonly string[];
  /** Whether a PATCH was sent. */
  readonly changed: boolean;
}

/** The list the job wants: the configured client, or none. */
export function desiredProgrammaticClients(clientId: string | null): string[] {
  return clientId ? [clientId] : [];
}

/** Whether two client lists hold exactly the same entries (order-insensitive, no duplicates). */
export function sameClients(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

/**
 * Make `programmaticClients` on the IAP resource at `resourceUrl` (an
 * `https://iap.googleapis.com/v1/projects/<n>/iap_web/...` URL without a
 * suffix) hold exactly `desired`. Throws `GoogleCallError` on a failed call.
 */
export async function reconcileProgrammaticClients(
  deps: GoogleDeps,
  resourceUrl: string,
  desired: readonly string[],
): Promise<ProgrammaticClientsReconciled> {
  const settings = (await googleCall(deps, `${resourceUrl}:iapSettings`, "GET")) as IapSettings;
  const before = [...(settings.accessSettings?.oauthSettings?.programmaticClients ?? [])];
  if (sameClients(before, desired)) return { before, after: before, changed: false };
  const name = resourceUrl.replace(/^https:\/\/iap\.googleapis\.com\/v1\//, "");
  await googleCall(
    deps,
    `${resourceUrl}:iapSettings?updateMask=${encodeURIComponent(PROGRAMMATIC_CLIENTS_MASK)}`,
    "PATCH",
    { name, accessSettings: { oauthSettings: { programmaticClients: [...desired] } } },
  );
  return { before, after: [...desired], changed: true };
}
