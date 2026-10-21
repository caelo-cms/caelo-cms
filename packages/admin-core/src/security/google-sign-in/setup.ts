// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #914 — the install's Google sign-in client (Settings → Google
 * sign-in): whether this install can have one, storing the client the Owner
 * created, and the self-check that proves each link of the chain works.
 *
 * One Owner-created Google OAuth client per install serves three uses —
 * never a second one:
 *
 *   - IAP browser login: IAP signs people in with it instead of its
 *     Google-managed client, which admits only the project organisation's
 *     accounts. With it, any Google account that is a Caelo user gets in
 *     (a gmail.com address, another company's Workspace).
 *   - IAP programmatic access (`programmaticClients`).
 *   - The remote-MCP broker (#806, Settings → MCP → Remote).
 *
 * The chain, and who owns each link:
 *
 *   1. The Owner creates the client (Web application) in the Google console
 *      — console-only, Google offers no API for it since 2026-03 — with two
 *      redirect URIs: the broker callback ({@link brokerRedirectUri}) and
 *      IAP's own ({@link iapRedirectUri}, known once the client ID is).
 *      The consent screen must be External + In production, or Google
 *      admits only test users and ends sessions after 7 days.
 *   2. The admin writes `{client_id, client_secret}` as a new version of the
 *      Secret Manager secret ({@link addSecretVersion}; the run SA may add
 *      versions, never read them) and records the ID (`operator_oauth.set`).
 *   3. The operator-access sync job (its own SA may read that secret) sets
 *      the project's IAP `oauthSettings` to the client (operator-access/iap-settings.ts).
 *   4. The self-check asks the admin's URL as a signed-out browser would and
 *      expects IAP to send it to Google with OUR client ID
 *      ({@link checkAdminSignInRedirect}).
 *
 * Every check reports ok/failed with the next step — a half-configured
 * install never looks finished.
 */

import {
  GOOGLE_IAP_PROVIDERS,
  GOOGLE_ORG_DOMAIN_ENV,
  parseOrganisationDomains,
} from "../identity-gate.js";
import { type GoogleDeps, googleCall } from "../operator-access/google-iam.js";

/** Admin env var naming the Secret Manager secret the Owner writes the client to. */
export const OPERATOR_OAUTH_CLIENT_STORE_ENV = "CAELO_OPERATOR_OAUTH_CLIENT_STORE";

/** The admin env Google sign-in needs (set by the provisioner). */
export interface GoogleSignInEnv {
  readonly CAELO_PROVIDER?: string;
  /** The admin's own URL behind IAP (what signed-out people open). */
  readonly CAELO_ADMIN_URL?: string;
  /** The remote-MCP broker's public origin (gateway) — its callback is one of the client's redirect URIs. */
  readonly CAELO_MCP_PUBLIC_URL?: string;
  /** `projects/<project>/secrets/<id>` the client is written to. */
  readonly CAELO_OPERATOR_OAUTH_CLIENT_STORE?: string;
  /** The project's Google organisation domain(s), `none`, or unset (unknown). */
  readonly CAELO_GOOGLE_ORG_DOMAIN?: string;
}

const SECRET_RESOURCE = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/secrets\/([A-Za-z0-9_-]+)$/;
const HTTPS_ORIGIN = /^https:\/\/[^/\s]+$/;

/** The broker callback every install registers on its Google sign-in client (contract #806). */
export function brokerRedirectUri(mcpPublicUrl: string): string {
  return `${mcpPublicUrl}/api/mcp/oauth/google-callback`;
}

/**
 * IAP's redirect URI for a custom OAuth client — it names the client ID, so
 * the setup page shows it once the Owner pasted the ID (defined in
 * @caelo-cms/shared so the page can compute it as the Owner types).
 */
export { iapRedirectUri } from "@caelo-cms/shared";

/** The Google console page that creates an OAuth client in `projectId` (Google Auth Platform → Clients → Create client). */
export function createOAuthClientConsoleUrl(projectId: string): string {
  return `https://console.cloud.google.com/auth/clients/create?project=${encodeURIComponent(projectId)}`;
}

/** The Google console page that lists the project's OAuth clients. */
export function oauthClientsConsoleUrl(projectId: string): string {
  return `https://console.cloud.google.com/auth/clients?project=${encodeURIComponent(projectId)}`;
}

/** The Google console page for the consent screen's audience (User type, publishing status). */
export function oauthAudienceConsoleUrl(projectId: string): string {
  return `https://console.cloud.google.com/auth/audience?project=${encodeURIComponent(projectId)}`;
}

export type GoogleSignInAvailability =
  | {
      /** Not a Google IAP install: Caelo's login is the only gate Caelo manages here. */
      readonly status: "not-available";
      readonly reason: string;
    }
  | {
      /** An IAP install the provisioner has not prepared yet. */
      readonly status: "needs-upgrade";
      readonly missing: readonly string[];
      readonly nextStep: string;
    }
  | {
      readonly status: "available";
      readonly projectId: string;
      readonly adminUrl: string;
      readonly secretResource: string;
      /** The broker callback (first redirect URI). */
      readonly brokerRedirectUri: string;
      readonly createClientUrl: string;
      readonly clientsUrl: string;
      readonly audienceUrl: string;
      /** The organisation's domains IAP admits without this client (`none` / `unknown` otherwise). */
      readonly organisationDomains: readonly string[] | "none" | "unknown";
    };

/** Whether this install can have a Google sign-in client, from the admin's env. */
export function googleSignInAvailability(env: GoogleSignInEnv): GoogleSignInAvailability {
  const provider = env.CAELO_PROVIDER?.trim() ?? "";
  if (!GOOGLE_IAP_PROVIDERS.has(provider)) {
    return {
      status: "not-available",
      reason:
        "Google sign-in belongs to Google IAP, which only the Google Cloud installs (gcp, gcp-firebase) put in front of the admin. On this install people sign in with their Caelo password; whoever runs the install's identity proxy allowlists them there.",
    };
  }
  const missing: string[] = [];
  const store = env.CAELO_OPERATOR_OAUTH_CLIENT_STORE?.trim() ?? "";
  const match = SECRET_RESOURCE.exec(store);
  if (!match) missing.push(OPERATOR_OAUTH_CLIENT_STORE_ENV);
  // The provisioner writes a bare origin; a trailing slash is not trimmed
  // (an unanchored /\/+$/ is polynomial on many slashes) but refused below.
  const adminUrl = (env.CAELO_ADMIN_URL ?? "").trim();
  if (!HTTPS_ORIGIN.test(adminUrl)) missing.push("CAELO_ADMIN_URL");
  const publicUrl = (env.CAELO_MCP_PUBLIC_URL ?? "").trim();
  if (!HTTPS_ORIGIN.test(publicUrl)) missing.push("CAELO_MCP_PUBLIC_URL");
  if (missing.length > 0 || !match) {
    return {
      status: "needs-upgrade",
      missing,
      nextStep:
        "Run `cms-provision upgrade` from the machine that provisioned this install: it prepares Google sign-in (the client's secret, its permissions, the admin's URL). Then reload this page.",
    };
  }
  const projectId = match[1] as string;
  return {
    status: "available",
    projectId,
    adminUrl,
    secretResource: store,
    brokerRedirectUri: brokerRedirectUri(publicUrl),
    createClientUrl: createOAuthClientConsoleUrl(projectId),
    clientsUrl: oauthClientsConsoleUrl(projectId),
    audienceUrl: oauthAudienceConsoleUrl(projectId),
    organisationDomains: parseOrganisationDomains(env[GOOGLE_ORG_DOMAIN_ENV]),
  };
}

/** A Google OAuth client secret as the console shows it (`GOCSPX-…`, older ones without the prefix). */
export const GOOGLE_OAUTH_CLIENT_SECRET = /^[A-Za-z0-9_-]{16,128}$/;

/** What the gateway's broker and the sync job read from the secret (contract #806/#914); `{}` = none. */
export function oauthClientFile(
  client: { readonly clientId: string; readonly clientSecret: string } | null,
): string {
  return client
    ? JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret })
    : "{}";
}

/**
 * Add `payload` as the new `latest` version of the secret at `resource`
 * (`projects/<p>/secrets/<id>`) — Secret Manager `versions.add`, the only
 * right the admin's run SA holds on it. Throws GoogleCallError.
 */
export async function addSecretVersion(
  deps: GoogleDeps,
  resource: string,
  payload: string,
): Promise<string> {
  const created = (await googleCall(
    deps,
    `https://secretmanager.googleapis.com/v1/${resource}:addVersion`,
    "POST",
    { payload: { data: Buffer.from(payload, "utf8").toString("base64") } },
  )) as { name?: string };
  if (!created.name) throw new Error(`Secret Manager returned no version name for ${resource}`);
  return created.name;
}

/** One line of a self-check (Google sign-in or remote MCP). */
export interface SelfCheckLine {
  readonly id:
    | "iap-sync"
    | "admin-sign-in"
    | "gateway-client"
    | "authorization-server"
    | "protected-resource";
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
  /** What to do when not ok. */
  readonly nextStep?: string;
}

export interface SelfCheckDeps {
  readonly fetch: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Outcome of the operator-access sync run, as {@link iapSyncLine} reads it. */
export type IapSyncOutcome =
  | {
      readonly status: "synced" | "running";
      readonly execution: string;
      readonly logsUrl: string;
    }
  | { readonly status: "failed"; readonly error: string; readonly nextStep: string }
  | { readonly status: "not-applicable"; readonly reason: string };

/** The operator-access sync outcome as a self-check line. */
export function iapSyncLine(sync: IapSyncOutcome, enabled = true): SelfCheckLine {
  const label = enabled
    ? "Google IAP uses this client"
    : "Google IAP no longer uses the removed client";
  switch (sync.status) {
    case "synced":
      return { id: "iap-sync", label, ok: true, detail: `sync job ${sync.execution}` };
    case "running":
      return {
        id: "iap-sync",
        label,
        ok: false,
        detail: `the sync job is still running (${sync.execution})`,
        nextStep: `It finishes on its own; run the check again in a minute. Log: ${sync.logsUrl}`,
      };
    case "failed":
      return { id: "iap-sync", label, ok: false, detail: sync.error, nextStep: sync.nextStep };
    case "not-applicable":
      return {
        id: "iap-sync",
        label,
        ok: false,
        detail: sync.reason,
        nextStep:
          "Run `cms-provision upgrade`: it sets up the operator-access sync job that hands the client to IAP.",
      };
  }
}

/** IAP applies new OAuth settings within about a minute; poll a little longer. */
export const SIGN_IN_PICKUP_TIMEOUT_MS = 75_000;
const POLL_INTERVAL_MS = 5_000;

/** The `client_id` IAP sends a signed-out visitor to Google with, or why there is none. */
async function signInClientOf(
  deps: SelfCheckDeps,
  adminUrl: string,
): Promise<{ ok: true; clientId: string } | { ok: false; error: string }> {
  try {
    const res = await deps.fetch(`${adminUrl}/`, {
      headers: { accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) {
      return { ok: false, error: `HTTP ${res.status} without a redirect to Google sign-in` };
    }
    const target = new URL(location, adminUrl);
    if (target.hostname !== "accounts.google.com") {
      return { ok: false, error: `it redirects to ${target.origin}, not to Google sign-in` };
    }
    const clientId = target.searchParams.get("client_id");
    return clientId
      ? { ok: true, clientId }
      : { ok: false, error: "the redirect to Google carries no client_id" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Open the admin as a signed-out browser would. With a client configured,
 * IAP must send the visitor to `accounts.google.com` with exactly
 * `clientId` — that proves IAP uses the client and, once someone signs in,
 * that Google accepts IAP's redirect URI. With `clientId` null (removed),
 * the redirect must no longer name `removedClientId`. Polls while IAP may
 * still serve the previous settings.
 */
export async function checkAdminSignInRedirect(
  deps: SelfCheckDeps,
  adminUrl: string,
  clientId: string | null,
  removedClientId: string | null = null,
  timeoutMs: number = SIGN_IN_PICKUP_TIMEOUT_MS,
): Promise<SelfCheckLine> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const label = clientId
    ? "Signing in to the admin uses this client"
    : "Signing in to the admin uses Google's built-in client again";
  const deadline = now() + timeoutMs;
  let last = "";
  for (;;) {
    const r = await signInClientOf(deps, adminUrl);
    if (r.ok) {
      const matches = clientId ? r.clientId === clientId : r.clientId !== removedClientId;
      if (matches) return { id: "admin-sign-in", label, ok: true, detail: adminUrl };
      last = clientId
        ? `IAP still signs people in with ${r.clientId}`
        : `IAP still signs people in with the removed client ${r.clientId}`;
    } else {
      last = r.error;
    }
    if (now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }
  return {
    id: "admin-sign-in",
    label,
    ok: false,
    detail: `${adminUrl}: ${last}`,
    nextStep: clientId
      ? "IAP picks up new settings within a few minutes — run the check again shortly. If it keeps failing, open the sync job's log (the line above) and check that the client's consent screen is External and In production."
      : "IAP picks up new settings within a few minutes — run the check again shortly.",
  };
}

/** The Google sign-in self-check, in the order the chain runs. */
export async function runSignInSelfCheck(
  deps: SelfCheckDeps,
  input: {
    readonly adminUrl: string;
    readonly clientId: string | null;
    readonly removedClientId?: string | null;
    readonly sync: IapSyncOutcome;
    readonly timeoutMs?: number;
  },
): Promise<SelfCheckLine[]> {
  const sync = iapSyncLine(input.sync, input.clientId !== null);
  return [
    sync,
    // Without a finished sync IAP cannot have changed yet: one look, no wait.
    await checkAdminSignInRedirect(
      deps,
      input.adminUrl,
      input.clientId,
      input.removedClientId ?? null,
      sync.ok ? input.timeoutMs : 0,
    ),
  ];
}
