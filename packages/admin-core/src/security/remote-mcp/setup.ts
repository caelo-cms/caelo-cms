// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — the Owner's remote-MCP setup (Settings → MCP → Remote):
 * whether this install can offer remote MCP at all, storing the Google OAuth
 * client the Owner created, and the self-check that proves each link of the
 * chain works.
 *
 * The chain, and who owns each link:
 *
 *   1. The Owner creates a Google OAuth client (Web application) in the
 *      Google console — console-only, Google offers no API for it — with the
 *      broker's callback as its one redirect URI.
 *   2. The admin writes `{client_id, client_secret}` as a new version of the
 *      Secret Manager secret the gateway mounts as a file
 *      ({@link storeOAuthClient}; the run SA may add versions, never read
 *      them) and records the client ID (`mcp_remote_oauth.set`).
 *   3. The operator-access sync job puts the client ID into the admin IAP
 *      resource's `programmatic_clients`, so IAP accepts users' tokens of
 *      that client (operator-access/iap-settings.ts).
 *   4. The gateway's broker re-reads the file within a minute and starts
 *      answering; the self-check asks it ({@link runSelfCheck}).
 *
 * Every check reports ok/failed with the next step — a half-configured
 * install never looks finished.
 */

import { createHash } from "node:crypto";
import { type GoogleDeps, googleCall } from "../operator-access/google-iam.js";

/** The admin env remote MCP needs (set by the provisioner, stack-contract.ts). */
export interface RemoteMcpEnv {
  readonly CAELO_PROVIDER?: string;
  /** The broker's public origin (gateway). */
  readonly CAELO_MCP_PUBLIC_URL?: string;
  /** The `aud` of the admin's IAP JWTs (read by the remote-MCP endpoints). */
  readonly CAELO_IAP_AUDIENCE?: string;
  /** `projects/<project>/secrets/<id>` the OAuth client is written to. */
  readonly CAELO_MCP_OAUTH_CLIENT_STORE?: string;
}

/** Providers whose admin sits behind Google IAP — the only ones remote MCP works on. */
const IAP_PROVIDERS = new Set(["gcp", "gcp-firebase"]);

const SECRET_RESOURCE = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/secrets\/([A-Za-z0-9_-]+)$/;

/** The broker callback every install registers on its Google OAuth client (contract #806). */
export function brokerRedirectUri(mcpPublicUrl: string): string {
  return `${mcpPublicUrl}/api/mcp/oauth/google-callback`;
}

/** The Google console page that creates an OAuth client in `projectId` (Google Auth Platform → Clients → Create client). */
export function createOAuthClientConsoleUrl(projectId: string): string {
  return `https://console.cloud.google.com/auth/clients/create?project=${encodeURIComponent(projectId)}`;
}

/** The Google console page that lists the project's OAuth clients. */
export function oauthClientsConsoleUrl(projectId: string): string {
  return `https://console.cloud.google.com/auth/clients?project=${encodeURIComponent(projectId)}`;
}

export type RemoteMcpAvailability =
  | {
      /** Not a Google IAP install: no remote MCP here (contract: "not available"). */
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
      readonly mcpPublicUrl: string;
      readonly secretResource: string;
      readonly redirectUri: string;
      readonly createClientUrl: string;
      readonly clientsUrl: string;
      /** The two MCP endpoints the Owner hands to clients. */
      readonly urls: { readonly chat: string; readonly admin: string };
    };

/** Whether this install can offer remote MCP, from the admin's env. */
export function remoteMcpAvailability(env: RemoteMcpEnv): RemoteMcpAvailability {
  const provider = env.CAELO_PROVIDER?.trim() ?? "";
  if (!IAP_PROVIDERS.has(provider)) {
    return {
      status: "not-available",
      reason:
        "Remote MCP needs the admin behind Google IAP, which only the Google Cloud installs (gcp, gcp-firebase) have. On this install connect MCP clients with an MCP token (above) and the local MCP server.",
    };
  }
  const required = [
    "CAELO_MCP_PUBLIC_URL",
    "CAELO_IAP_AUDIENCE",
    "CAELO_MCP_OAUTH_CLIENT_STORE",
  ] as const;
  const missing = required.filter((name) => !env[name]?.trim());
  const resource = env.CAELO_MCP_OAUTH_CLIENT_STORE?.trim() ?? "";
  const match = SECRET_RESOURCE.exec(resource);
  if (resource && !match) missing.push("CAELO_MCP_OAUTH_CLIENT_STORE");
  const publicUrl = (env.CAELO_MCP_PUBLIC_URL ?? "").trim();
  if (publicUrl && !/^https:\/\/[^/\s]+$/.test(publicUrl)) missing.push("CAELO_MCP_PUBLIC_URL");
  if (missing.length > 0 || !match) {
    return {
      status: "needs-upgrade",
      missing: [...new Set(missing)],
      nextStep:
        "Run `cms-provision upgrade` from the machine that provisioned this install: it prepares remote MCP (secrets, permissions, URLs). Then reload this page.",
    };
  }
  const projectId = match[1] as string;
  return {
    status: "available",
    projectId,
    mcpPublicUrl: publicUrl,
    secretResource: resource,
    redirectUri: brokerRedirectUri(publicUrl),
    createClientUrl: createOAuthClientConsoleUrl(projectId),
    clientsUrl: oauthClientsConsoleUrl(projectId),
    urls: { chat: `${publicUrl}/api/mcp/chat`, admin: `${publicUrl}/api/mcp/admin` },
  };
}

/** A Google OAuth client secret as the console shows it (`GOCSPX-…`, older ones without the prefix). */
export const GOOGLE_OAUTH_CLIENT_SECRET = /^[A-Za-z0-9_-]{16,128}$/;

/** What the gateway's broker reads from the secret file (contract #806); `{}` = not configured. */
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

/** SHA-256 of a client ID, as hex and as base64url (the broker reports one of them). */
export function clientIdDigests(clientId: string): { hex: string; base64url: string } {
  const digest = createHash("sha256").update(clientId, "utf8").digest();
  return { hex: digest.toString("hex"), base64url: digest.toString("base64url") };
}

/** One line of the self-check. */
export interface SelfCheckLine {
  readonly id: "gateway-client" | "authorization-server" | "protected-resource" | "iap-sync";
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

/** The broker re-reads its client within 60 s (contract); poll a little longer. */
export const GATEWAY_PICKUP_TIMEOUT_MS = 75_000;
const POLL_INTERVAL_MS = 5_000;

async function getJson(
  deps: SelfCheckDeps,
  url: string,
): Promise<{ ok: true; status: number; body: unknown } | { ok: false; error: string }> {
  try {
    const res = await deps.fetch(url, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, error: `HTTP ${res.status}, not JSON: ${text.slice(0, 120)}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Whether the broker serves `clientId` (or, with `null`, reports itself not
 * configured), polling while it may still hold the previous file.
 */
export async function checkGatewayClient(
  deps: SelfCheckDeps,
  mcpPublicUrl: string,
  clientId: string | null,
  timeoutMs: number = GATEWAY_PICKUP_TIMEOUT_MS,
): Promise<SelfCheckLine> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const url = `${mcpPublicUrl}/api/mcp/oauth/status`;
  const want = clientId ? clientIdDigests(clientId) : null;
  const label = clientId
    ? "The gateway signs users in with this client"
    : "The gateway reports remote MCP as off";
  const deadline = now() + timeoutMs;
  let last = "";
  for (;;) {
    const r = await getJson(deps, url);
    if (r.ok) {
      const body = r.body as { configured?: unknown; clientIdSha256?: unknown };
      const sha = typeof body.clientIdSha256 === "string" ? body.clientIdSha256 : "";
      const matches = want
        ? body.configured === true && (sha === want.hex || sha === want.base64url)
        : body.configured === false;
      if (matches) return { id: "gateway-client", label, ok: true, detail: url };
      last =
        body.configured === true
          ? "it still serves another client"
          : `it reports ${body.configured === false ? "not configured" : `HTTP ${r.status}`}`;
    } else {
      last = r.error;
    }
    if (now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }
  return {
    id: "gateway-client",
    label,
    ok: false,
    detail: `${url}: ${last}`,
    nextStep:
      "The gateway re-reads its client within a minute — run the check again shortly. If it keeps failing, run `cms-provision upgrade` (it mounts the client file on the gateway) and check the gateway's logs.",
  };
}

/** The broker's authorization-server metadata is reachable at the issuer's well-known URL. */
export async function checkAuthorizationServer(
  deps: SelfCheckDeps,
  mcpPublicUrl: string,
): Promise<SelfCheckLine> {
  const issuer = `${mcpPublicUrl}/api/mcp/oauth`;
  const url = `${mcpPublicUrl}/.well-known/oauth-authorization-server/api/mcp/oauth`;
  const label = "MCP clients find the sign-in server";
  const r = await getJson(deps, url);
  const ok = r.ok && (r.body as { issuer?: unknown }).issuer === issuer;
  return ok
    ? { id: "authorization-server", label, ok, detail: url }
    : {
        id: "authorization-server",
        label,
        ok: false,
        detail: `${url}: ${r.ok ? `issuer is not ${issuer}` : r.error}`,
        nextStep: mcpPublicUrl.includes(".run.app")
          ? "The gateway does not answer yet. Run `cms-provision upgrade`, then check again."
          : "This URL must reach the gateway through the load balancer. If the site's domain does not point at the load balancer yet (before go-live), remote MCP works once it does; otherwise run `cms-provision upgrade` (it adds the routes).",
      };
}

/** The protected-resource metadata of the chat endpoint names this broker. */
export async function checkProtectedResource(
  deps: SelfCheckDeps,
  mcpPublicUrl: string,
): Promise<SelfCheckLine> {
  const url = `${mcpPublicUrl}/.well-known/oauth-protected-resource/api/mcp/chat`;
  const label = "MCP clients learn where to sign in";
  const r = await getJson(deps, url);
  const body = (r.ok ? r.body : {}) as { resource?: unknown; authorization_servers?: unknown };
  const ok =
    r.ok &&
    body.resource === `${mcpPublicUrl}/api/mcp/chat` &&
    Array.isArray(body.authorization_servers) &&
    body.authorization_servers.includes(`${mcpPublicUrl}/api/mcp/oauth`);
  return ok
    ? { id: "protected-resource", label, ok, detail: url }
    : {
        id: "protected-resource",
        label,
        ok: false,
        detail: `${url}: ${r.ok ? "unexpected metadata" : r.error}`,
        nextStep: "Run `cms-provision upgrade` (it routes the discovery paths), then check again.",
      };
}

/** The operator-access sync outcome as a self-check line. */
export function iapSyncLine(
  sync:
    | {
        readonly status: "synced" | "running";
        readonly execution: string;
        readonly logsUrl: string;
      }
    | { readonly status: "failed"; readonly error: string; readonly nextStep: string }
    | { readonly status: "not-applicable"; readonly reason: string },
  enabled = true,
): SelfCheckLine {
  const label = enabled
    ? "Google IAP accepts sign-ins from this client"
    : "Google IAP no longer accepts sign-ins from the old client";
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
          "Run `cms-provision upgrade`: it sets up the operator-access sync job that allowlists the client in IAP.",
      };
  }
}

/** The whole self-check, in the order the chain runs. */
export async function runSelfCheck(
  deps: SelfCheckDeps,
  input: {
    readonly mcpPublicUrl: string;
    readonly clientId: string | null;
    readonly sync: Parameters<typeof iapSyncLine>[0];
    readonly gatewayTimeoutMs?: number;
  },
): Promise<SelfCheckLine[]> {
  const lines: SelfCheckLine[] = [iapSyncLine(input.sync, input.clientId !== null)];
  lines.push(
    await checkGatewayClient(deps, input.mcpPublicUrl, input.clientId, input.gatewayTimeoutMs),
  );
  if (input.clientId) {
    lines.push(await checkAuthorizationServer(deps, input.mcpPublicUrl));
    lines.push(await checkProtectedResource(deps, input.mcpPublicUrl));
  }
  return lines;
}
