// SPDX-License-Identifier: MPL-2.0

/**
 * #678 — `staging-domain enable` tells the admin itself what the operator
 * decided, instead of printing "now set the same host in the admin".
 *
 * Why an HTTP call to the admin (and not a one-shot Cloud Run job like the
 * migrations): the call must hand a result BACK — above all the generated
 * basic-auth password, which the CLI prints once. A job can only report
 * through Cloud Logging, which would put the password into the project's
 * logs. The admin endpoint (`POST /api/internal/staging/provision`) answers
 * over TLS straight to this process, and the password is never written
 * anywhere (CLAUDE.md §7, #659).
 *
 * Getting there, as the operator's own gcloud identity — the same path the
 * Power-MCP shim takes (packages/mcp-server/src/ingress-auth.ts):
 *
 *   1. the admin Cloud Run service and its URL;
 *   2. the install's internal secret from Secret Manager (in memory only),
 *      which signs a 5-minute token for scope `staging.provision`;
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

/** Token scope the admin endpoint checks (apps/admin …/api/internal/staging/provision). */
export const STAGING_PROVISION_SCOPE = "staging.provision";
const ENDPOINT = "/api/internal/staging/provision";
/** Signed JWTs live at most 1 hour; one call needs a few seconds. */
const IAP_JWT_LIFETIME_S = 600;

export interface StagingAdminTarget {
  readonly projectId: string;
  readonly region: string;
}

export interface StagingAdminDeps {
  readonly run?: Run;
  readonly fetch?: typeof fetch;
  /** Seconds since epoch (IAP JWT); tests pin it. */
  readonly now?: () => number;
}

/** Main's draft pages, as the admin reports them. */
export interface DraftPages {
  readonly count: number;
  readonly pages: readonly { title: string; path: string }[];
}

/** `{"mode":"inspect"}` — the admin's stored host and gate state. */
export interface StagingInspect {
  readonly stagingHost: string | null;
  readonly stageNeeded: "nothing-staged" | "host-changed" | null;
  readonly stageNote: string | null;
  readonly settings: { readonly basicAuthEnabled: boolean; readonly basicAuthGenerated: boolean };
}

/** `{"mode":"apply"}` — what `staging_access.provision` did. */
export interface StagingApply {
  readonly host: string;
  readonly previousHost: string | null;
  readonly hostChanged: boolean;
  readonly stagingUrl: string;
  readonly basicAuth: {
    readonly status: "generated" | "rotated" | "unchanged-enabled" | "unchanged-disabled";
    readonly enabled: boolean;
    readonly user: string;
    readonly password: string | null;
  };
  readonly stageNeeded: "nothing-staged" | "host-changed" | null;
  readonly stageNote: string | null;
  readonly draftPages: DraftPages;
}

export type StagingAdminResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ApplyRequest {
  readonly host?: string;
  readonly rotateBasicAuth?: boolean;
  readonly revealBasicAuth?: boolean;
}

/** Read the admin's stored staging host (the truth `staging-domain enable` maps). */
export function inspectStagingAdmin(
  target: StagingAdminTarget,
  deps: StagingAdminDeps = {},
): Promise<StagingAdminResult<StagingInspect>> {
  return callStagingAdmin<StagingInspect>(target, { mode: "inspect" }, deps);
}

/** Set the host / ensure password protection (see the admin op `staging_access.provision`). */
export function applyStagingAdmin(
  target: StagingAdminTarget,
  request: ApplyRequest,
  deps: StagingAdminDeps = {},
): Promise<StagingAdminResult<StagingApply>> {
  return callStagingAdmin<StagingApply>(target, { mode: "apply", ...request }, deps);
}

async function callStagingAdmin<T>(
  target: StagingAdminTarget,
  body: Record<string, unknown>,
  deps: StagingAdminDeps,
): Promise<StagingAdminResult<T>> {
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

  const iap = await signIapJwt(run, doFetch, target.projectId, adminUrl, deps.now);
  if (!iap.ok) return iap;

  const token = await mintInternalToken(internalSecret, STAGING_PROVISION_SCOPE);
  let res: Response;
  try {
    res = await doFetch(`${adminUrl}${ENDPOINT}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${iap.value}`,
        "x-caelo-internal-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
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
      error: `the admin has no ${ENDPOINT} yet (it runs a release from before #678). Run \`cms-provision upgrade\`, then run this command again.`,
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
  return { ok: true, value: parsed as unknown as T };
}

/** A JWT signed as the install's MCP service account, for the admin's IAP. */
async function signIapJwt(
  run: Run,
  doFetch: typeof fetch,
  projectId: string,
  adminUrl: string,
  now: (() => number) | undefined,
): Promise<StagingAdminResult<string>> {
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

/**
 * The lines `staging-domain enable` prints for an apply result: host,
 * credentials (once), what is served and the next step. Pure — the CLI
 * prints them and never persists the password.
 */
export function describeStagingApply(r: StagingApply): string[] {
  const lines: string[] = [];
  lines.push(
    r.hostChanged
      ? `The admin now uses ${r.host} as the staging host (was ${r.previousHost ?? "unset"}); every Stage renders it.`
      : `The admin's staging host is ${r.host}.`,
  );
  const b = r.basicAuth;
  if (b.password !== null && (b.status === "generated" || b.status === "rotated")) {
    lines.push(
      "",
      b.status === "generated"
        ? "Password protection is on (basic auth). Credentials — shown only now, not saved anywhere:"
        : "New basic-auth password — shown only now, not saved anywhere (the old one no longer works):",
      `  user:     ${b.user}`,
      `  password: ${b.password}`,
      "Give them to reviewers / crawlers. Change the user, rotate the password or add other access",
      "modes in the admin: Security → Staging access (or rerun with --rotate-staging-password).",
    );
  } else if (b.password !== null) {
    lines.push(
      "",
      `Basic auth is ${b.enabled ? "on" : "OFF (switched off in the admin)"}. Current credentials — not saved anywhere:`,
      `  user:     ${b.user}`,
      `  password: ${b.password}`,
    );
  } else if (b.status === "unchanged-enabled") {
    lines.push(
      "",
      `Password protection is on (basic auth, user ${b.user}). Show the password with --show-staging-password, or in the admin under Security → Staging access.`,
    );
  } else {
    lines.push(
      "",
      "Basic auth was switched off in the admin; it stays off (admins still get in through Open staging). Turn it on under Security → Staging access.",
    );
  }
  if (r.stageNote) lines.push("", r.stageNote);
  if (r.draftPages.count > 0) {
    const listed = r.draftPages.pages.map((p) => `${p.title} (${p.path})`).join(", ");
    const more =
      r.draftPages.count > r.draftPages.pages.length
        ? ` and ${r.draftPages.count - r.draftPages.pages.length} more`
        : "";
    lines.push(
      "",
      `${r.draftPages.count} page(s) are draft and will NOT be on staging: ${listed}${more}.`,
      "Set them to published (editor status toggle, or ask the AI), then Stage.",
    );
  }
  return lines;
}

/**
 * The command to re-run after `<kind>-domain enable` stopped before the
 * admin was updated (domain verification, an admin error). An explicitly
 * requested staging host is part of it: without it the retry would map the
 * admin's previous host instead (codex review on #681).
 */
export function domainEnableRetryCommand(command: string, requestedHost: string | null): string {
  return `cms-provision ${command} enable${requestedHost ? ` --staging-domain ${requestedHost}` : ""}`;
}
