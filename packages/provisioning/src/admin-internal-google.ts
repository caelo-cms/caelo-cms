// SPDX-License-Identifier: MPL-2.0

/**
 * admin-internal.ts on Google Cloud, as the operator's own gcloud identity —
 * the same path the Power-MCP shim takes (packages/mcp-server/src/ingress-auth.ts):
 *
 *   1. the admin's URL: on gcp-firebase the admin Cloud Run service's own
 *      URL (IAP sits on the service); on gcp `https://admin.<domain>` (IAP
 *      sits on the load balancer's admin backend, and the service's
 *      run.app URL accepts only load-balancer traffic);
 *   2. the install's internal secret from Secret Manager (in memory only),
 *      which signs a 5-minute token for the endpoint's scope;
 *   3. a JWT signed as `caelo-mcp@<project>` through the IAM Credentials
 *      API with `aud` = `<admin origin>/*` — the audience IAP's service-
 *      account JWT path checks on both resource kinds
 *      (cloud.google.com/iap/docs/authentication-howto). The admin's IAP
 *      lets that service account in, and every IAP-allowlisted operator may
 *      sign as it (`cms-provision upgrade` grants both), so the request
 *      passes IAP first, then Caelo's token.
 */

import { findService } from "./admin-domain.js";
import type {
  AdminInternalAnswer,
  AdminInternalCall,
  AdminInternalDeps,
  AdminInternalResult,
  GoogleAdminTarget,
} from "./admin-internal.js";
import { readAdminAnswer } from "./admin-internal-answer.js";
import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { GCP_STACK_ENV, gcpSecretId, mcpIapServiceAccountEmail } from "./gcp-names.js";
import { mintInternalToken } from "./internal-token.js";

type Run = (args: string[]) => Promise<GcloudResult>;

/** Signed JWTs live at most 1 hour; one call needs a few seconds. */
const IAP_JWT_LIFETIME_S = 600;

/** The admin call on a gcp / gcp-firebase install (see the file comment). */
export async function callGoogleAdmin<T>(
  target: GoogleAdminTarget,
  call: AdminInternalCall,
  deps: AdminInternalDeps,
): Promise<AdminInternalAnswer<T>> {
  const run = deps.run ?? defaultGcloud;
  const doFetch = deps.fetch ?? fetch;

  const admin = await adminUrl(run, target);
  if (!admin.ok) return admin;

  const secretId = gcpSecretId(GCP_STACK_ENV, "internal-secret");
  const secret = await run([
    "secrets",
    "versions",
    "access",
    "latest",
    `--secret=${secretId}`,
    `--project=${target.projectId}`,
  ]);
  const internalSecret = secret.stdout.trim();
  if (!secret.ok || internalSecret.length < 32) {
    return {
      ok: false,
      error: `read the install's internal secret (${secretId}) from Secret Manager: ${secret.stderr.trim() || "missing or too short"}. Your gcloud account needs secretmanager.versions.access on the project.`,
    };
  }

  // Installs from before #678 may not have the IAM Credentials API on;
  // enabling an enabled API is a no-op (codex review on #681).
  const api = await run([
    "services",
    "enable",
    "iamcredentials.googleapis.com",
    `--project=${target.projectId}`,
  ]);
  if (!api.ok) {
    return {
      ok: false,
      error: `enable the IAM Credentials API (iamcredentials.googleapis.com), needed to pass the admin's IAP: ${api.stderr.trim()}`,
    };
  }
  const iap = await signIapJwt(run, doFetch, target.projectId, admin.value, deps.now);
  if (!iap.ok) return iap;

  const token = await mintInternalToken(internalSecret, call.scope);
  let res: Response;
  try {
    res = await doFetch(`${admin.value}${call.endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${iap.value}`,
        "x-caelo-internal-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify(call.body),
    });
  } catch (e) {
    return {
      ok: false,
      error: `reach the admin at ${admin.value}: ${String(e)}${unreachableHint(target)}`,
    };
  }
  const text = await res.text();
  if (res.headers.get("x-goog-iap-generated-response") === "true") {
    return {
      ok: false,
      error: `Google IAP refused the request (HTTP ${res.status}: ${text.trim().slice(0, 200)}) — ${mcpIapServiceAccountEmail(target.projectId)} is not allowed on the admin's IAP yet. Run \`cms-provision upgrade\` (it allowlists that service account), then run this command again.`,
    };
  }
  const answer = readAdminAnswer<T>(res.status, text, call, "cms-provision upgrade");
  return answer.ok ? { ok: true, value: { answer: answer.value, adminUrl: admin.value } } : answer;
}

/** Where the admin answers behind IAP (see the file comment, step 1). */
async function adminUrl(run: Run, target: GoogleAdminTarget): Promise<AdminInternalResult<string>> {
  if (target.provider === "gcp") return { ok: true, value: `https://admin.${target.domain}` };
  const scope = [`--region=${target.region}`, `--project=${target.projectId}`];
  const found = await findService(run, scope, "admin");
  if (!found.ok) return { ok: false, error: found.error };
  const url = await run([
    "run",
    "services",
    "describe",
    found.service,
    ...scope,
    "--format=value(status.url)",
  ]);
  const value = url.stdout.trim();
  if (!url.ok || !value) {
    return { ok: false, error: `read the admin's URL: ${url.stderr.trim() || "empty"}` };
  }
  return { ok: true, value };
}

/** On gcp the admin's host must resolve to the load balancer and have its certificate. */
function unreachableHint(target: GoogleAdminTarget): string {
  return target.provider === "gcp"
    ? ` — admin.${target.domain} must resolve to the install's load balancer with an ACTIVE certificate (check \`dig +short admin.${target.domain}\`).`
    : "";
}

/** A JWT signed as the install's MCP service account, for the admin's IAP. */
async function signIapJwt(
  run: Run,
  doFetch: typeof fetch,
  projectId: string,
  adminUrl: string,
  now: (() => number) | undefined,
): Promise<AdminInternalResult<string>> {
  const access = await run(["auth", "print-access-token"]);
  const accessToken = access.stdout.trim();
  if (!access.ok || !accessToken) {
    return {
      ok: false,
      error: `get an access token from gcloud: ${access.stderr.trim() || "empty"}. Run \`gcloud auth login\` with the account you provisioned with.`,
    };
  }
  const serviceAccount = mcpIapServiceAccountEmail(projectId);
  const iat = now ? now() : Math.floor(Date.now() / 1000);
  const res = await doFetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:signJwt`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        payload: JSON.stringify({
          iss: serviceAccount,
          sub: serviceAccount,
          aud: `${new URL(adminUrl).origin}/*`,
          iat,
          exp: iat + IAP_JWT_LIFETIME_S,
        }),
      }),
    },
  );
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    return {
      ok: false,
      error: `sign an IAP token as ${serviceAccount} (HTTP ${res.status}): ${detail} — your account needs roles/iam.serviceAccountTokenCreator on it; \`cms-provision upgrade\` grants it to everyone the admin's IAP lets in.`,
    };
  }
  const { signedJwt } = (await res.json()) as { signedJwt?: string };
  if (!signedJwt) return { ok: false, error: "IAM signJwt answered without a signedJwt" };
  return { ok: true, value: signedJwt };
}
