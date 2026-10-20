// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — remote MCP (Settings → MCP → Remote): whether this install
 * can offer it, and the self-check of the broker's part of the chain.
 *
 * Remote MCP signs people in with the install's Google sign-in client
 * (#914) — the same one IAP uses for browser login. That client is set up,
 * replaced and removed under Settings → Google sign-in
 * (security/google-sign-in/), never here: one client per install. Remote MCP
 * is on whenever that client is configured; the gateway's broker re-reads
 * it from its secret file within a minute.
 *
 * What stays MCP-specific, checked here:
 *
 *   - the broker serves the configured client ({@link checkGatewayClient});
 *   - MCP clients find the sign-in server and learn where to sign in
 *     (the OAuth discovery documents).
 */

import type { SelfCheckDeps, SelfCheckLine } from "../google-sign-in/setup.js";
import { GOOGLE_IAP_PROVIDERS, GOOGLE_SIGN_IN_SETTINGS_PATH } from "../identity-gate.js";

/** The admin env remote MCP needs (set by the provisioner, stack-contract.ts). */
export interface RemoteMcpEnv {
  readonly CAELO_PROVIDER?: string;
  /** The broker's public origin (gateway). */
  readonly CAELO_MCP_PUBLIC_URL?: string;
  /** The `aud` of the admin's IAP JWTs (read by the remote-MCP endpoints). */
  readonly CAELO_IAP_AUDIENCE?: string;
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
      readonly mcpPublicUrl: string;
      /** Where the sign-in client is set up (Settings → Google sign-in). */
      readonly signInSettingsPath: string;
      /** The two MCP endpoints the Owner hands to clients. */
      readonly urls: { readonly chat: string; readonly admin: string };
    };

/** Whether this install can offer remote MCP, from the admin's env. */
export function remoteMcpAvailability(env: RemoteMcpEnv): RemoteMcpAvailability {
  const provider = env.CAELO_PROVIDER?.trim() ?? "";
  if (!GOOGLE_IAP_PROVIDERS.has(provider)) {
    return {
      status: "not-available",
      reason:
        "Remote MCP needs the admin behind Google IAP, which only the Google Cloud installs (gcp, gcp-firebase) have. On this install connect MCP clients with an MCP token (above) and the local MCP server.",
    };
  }
  const missing: string[] = [];
  const publicUrl = (env.CAELO_MCP_PUBLIC_URL ?? "").trim();
  if (!/^https:\/\/[^/\s]+$/.test(publicUrl)) missing.push("CAELO_MCP_PUBLIC_URL");
  if (!env.CAELO_IAP_AUDIENCE?.trim()) missing.push("CAELO_IAP_AUDIENCE");
  if (missing.length > 0) {
    return {
      status: "needs-upgrade",
      missing,
      nextStep:
        "Run `cms-provision upgrade` from the machine that provisioned this install: it prepares remote MCP (secrets, permissions, URLs). Then reload this page.",
    };
  }
  return {
    status: "available",
    mcpPublicUrl: publicUrl,
    signInSettingsPath: GOOGLE_SIGN_IN_SETTINGS_PATH,
    urls: { chat: `${publicUrl}/api/mcp/chat`, admin: `${publicUrl}/api/mcp/admin` },
  };
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
  const label = clientId
    ? "The gateway signs MCP users in with this install's Google sign-in client"
    : "The gateway reports remote MCP as off";
  const deadline = now() + timeoutMs;
  let last = "";
  for (;;) {
    const r = await getJson(deps, url);
    if (r.ok) {
      const body = r.body as { configured?: unknown; clientId?: unknown };
      const matches = clientId
        ? body.configured === true && body.clientId === clientId
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

/**
 * The broker's part of the chain for the configured Google sign-in client:
 * the gateway serves it, then the two discovery documents. Without a client
 * only the gateway's "off" is checked.
 */
export async function runRemoteMcpSelfCheck(
  deps: SelfCheckDeps,
  input: {
    readonly mcpPublicUrl: string;
    readonly clientId: string | null;
    readonly gatewayTimeoutMs?: number;
  },
): Promise<SelfCheckLine[]> {
  const lines: SelfCheckLine[] = [
    await checkGatewayClient(deps, input.mcpPublicUrl, input.clientId, input.gatewayTimeoutMs),
  ];
  if (input.clientId) {
    lines.push(await checkAuthorizationServer(deps, input.mcpPublicUrl));
    lines.push(await checkProtectedResource(deps, input.mcpPublicUrl));
  }
  return lines;
}
