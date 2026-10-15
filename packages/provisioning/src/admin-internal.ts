// SPDX-License-Identifier: MPL-2.0

/**
 * The CLI's channel to the admin's `/api/internal/*` endpoints on a
 * gcp-firebase install, for commands that need an answer BACK from the admin
 * (a generated password, a reset link). A one-shot Cloud Run job could only
 * report through Cloud Logging, which would put that secret into the
 * project's logs; this call answers over TLS straight to the CLI process, and
 * nothing is written anywhere (CLAUDE.md §7, #659).
 *
 * Getting there, as the operator's own gcloud identity — the same path the
 * Power-MCP shim takes (packages/mcp-server/src/ingress-auth.ts):
 *
 *   1. the admin Cloud Run service and its URL;
 *   2. the install's internal secret from Secret Manager (in memory only),
 *      which signs a 5-minute token for the endpoint's scope;
 *   3. a JWT signed as `caelo-mcp@<project>` through the IAM Credentials
 *      API — the admin's IAP lets that service account in, and every
 *      IAP-allowlisted operator may sign as it (`cms-provision upgrade`
 *      grants it) — so the request passes IAP first, then Caelo's token.
 */

import { findService } from "./admin-domain.js";
import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { GCP_STACK_ENV, gcpSecretId, mcpIapServiceAccountEmail } from "./gcp-names.js";
import { mintInternalToken } from "./internal-token.js";

type Run = (args: string[]) => Promise<GcloudResult>;

/** Signed JWTs live at most 1 hour; one call needs a few seconds. */
const IAP_JWT_LIFETIME_S = 600;

export interface AdminInternalTarget {
  readonly projectId: string;
  readonly region: string;
}

export interface AdminInternalDeps {
  readonly run?: Run;
  readonly fetch?: typeof fetch;
  /** Seconds since epoch (IAP JWT); tests pin it. */
  readonly now?: () => number;
}

/** One endpoint call: where, under which token scope, with what body. */
export interface AdminInternalCall {
  /** Path under the admin origin, e.g. `/api/internal/owner-reset`. */
  readonly endpoint: string;
  /** Scope the endpoint's `requireInternalAuth` checks. */
  readonly scope: string;
  readonly body: Record<string, unknown>;
  /** The issue that added the endpoint, named when an older admin answers 404. */
  readonly introducedBy: string;
}

export type AdminInternalResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * POST `call.body` to the endpoint and return the admin's JSON answer and
 * the admin URL it was reached at (to build links the operator opens).
 * Every failure names the fix: an IAP refusal or a pre-endpoint admin points
 * at `cms-provision upgrade`, a refusal carries the admin's own message.
 */
export async function callAdminInternal<T>(
  target: AdminInternalTarget,
  call: AdminInternalCall,
  deps: AdminInternalDeps = {},
): Promise<AdminInternalResult<{ answer: T; adminUrl: string }>> {
  const run = deps.run ?? defaultGcloud;
  const doFetch = deps.fetch ?? fetch;
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
  const adminUrl = url.stdout.trim();
  if (!url.ok || !adminUrl) {
    return { ok: false, error: `read the admin's URL: ${url.stderr.trim() || "empty"}` };
  }

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
  const iap = await signIapJwt(run, doFetch, target.projectId, adminUrl, deps.now);
  if (!iap.ok) return iap;

  const token = await mintInternalToken(internalSecret, call.scope);
  let res: Response;
  try {
    res = await doFetch(`${adminUrl}${call.endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${iap.value}`,
        "x-caelo-internal-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify(call.body),
    });
  } catch (e) {
    return { ok: false, error: `reach the admin at ${adminUrl}: ${String(e)}` };
  }
  const text = await res.text();
  if (res.headers.get("x-goog-iap-generated-response") === "true") {
    return {
      ok: false,
      error: `Google IAP refused the request (HTTP ${res.status}: ${text.trim().slice(0, 200)}) — ${mcpIapServiceAccountEmail(target.projectId)} is not allowed on the admin's IAP yet. Run \`cms-provision upgrade\` (it allowlists that service account), then run this command again.`,
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      error: `the admin has no ${call.endpoint} yet (it runs a release from before ${call.introducedBy}). Run \`cms-provision upgrade\`, then run this command again.`,
    };
  }
  let parsed: { ok?: boolean; error?: string } & Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return {
      ok: false,
      error: `the admin answered HTTP ${res.status} with a non-JSON body: ${text.slice(0, 200)}`,
    };
  }
  if (!res.ok || parsed.ok !== true) {
    return {
      ok: false,
      error: `the admin refused (HTTP ${res.status}): ${parsed.error ?? text.slice(0, 300)}`,
    };
  }
  return { ok: true, value: { answer: parsed as unknown as T, adminUrl } };
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
