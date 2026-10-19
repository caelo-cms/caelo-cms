// SPDX-License-Identifier: MPL-2.0

/**
 * Shared fakes for the remote-MCP tests (#806): a router wired to an
 * injected fetch that plays Google's token endpoint, CIMD hosts and the
 * admin, and helpers that walk the OAuth flow. Test-only; not imported by
 * the gateway.
 */

import { createHash, randomBytes } from "node:crypto";
import { GOOGLE_TOKEN_URL } from "../google.js";
import { createMcpRouter, type McpRouter } from "../routes.js";

export const PUBLIC = "https://gw.example.com";
export const ISSUER = `${PUBLIC}/api/mcp/oauth`;
export const ADMIN = "https://admin.example.com";
export const GOOGLE_CLIENT_ID = "1234-abc.apps.googleusercontent.com";
export const GOOGLE_CLIENT_SECRET = "GOCSPX-test-secret";
export const SEAL_KEY_B64 = randomBytes(32).toString("base64");
export const CLIENT_FILE = "/secrets/mcp-oauth-client/latest";
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

export const BASE_ENV: Record<string, string> = {
  CAELO_MCP_PUBLIC_URL: PUBLIC,
  CAELO_ADMIN_URL: ADMIN,
  CAELO_MCP_OAUTH_SEAL_KEY: SEAL_KEY_B64,
  CAELO_MCP_OAUTH_CLIENT_FILE: CLIENT_FILE,
};

export const CONFIGURED_FILE = JSON.stringify({
  client_id: GOOGLE_CLIENT_ID,
  client_secret: GOOGLE_CLIENT_SECRET,
});

export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

export interface HarnessOptions {
  env?: Record<string, string | undefined>;
  clientFile?: string | (() => string);
  /** Google's token endpoint; gets the posted form. */
  google?: (form: URLSearchParams) => Response | Promise<Response>;
  /** Any other outbound URL (CIMD documents, the admin). */
  other?: (url: string, init: RequestInit) => Response | Promise<Response>;
}

export interface Harness {
  readonly router: McpRouter;
  readonly calls: FetchCall[];
  readonly googleForms: URLSearchParams[];
  /** Move the clock (ms). */
  advance(ms: number): void;
  /** Send a request through the router; fails the test if the router declines it. */
  send(path: string, init?: RequestInit): Promise<Response>;
}

export function defaultGoogle(form: URLSearchParams): Response {
  if (form.get("grant_type") === "authorization_code") {
    return Response.json({
      access_token: "ya29.google-access",
      expires_in: 3599,
      token_type: "Bearer",
      refresh_token: "1//google-refresh",
      scope: "openid https://www.googleapis.com/auth/userinfo.email",
      id_token: "eyJ.id.token",
    });
  }
  return Response.json({ access_token: "ya29.refreshed", expires_in: 3599, token_type: "Bearer" });
}

export function harness(opts: HarnessOptions = {}): Harness {
  let now = 1_800_000_000_000;
  const calls: FetchCall[] = [];
  const googleForms: URLSearchParams[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (url === GOOGLE_TOKEN_URL) {
      const form = new URLSearchParams(String(init.body));
      googleForms.push(form);
      return (opts.google ?? defaultGoogle)(form);
    }
    if (opts.other) return opts.other(url, init);
    throw new Error(`unexpected outbound fetch to ${url}`);
  }) as typeof fetch;
  const env = { ...BASE_ENV, ...(opts.env ?? {}) };
  const router = createMcpRouter({
    env,
    readFile: async (path) => {
      if (path !== CLIENT_FILE) throw new Error("ENOENT");
      const f = opts.clientFile ?? CONFIGURED_FILE;
      return typeof f === "function" ? f() : f;
    },
    fetchImpl,
    nowMs: () => now,
  });
  return {
    router,
    calls,
    googleForms,
    advance(ms) {
      now += ms;
    },
    async send(path, init) {
      const res = await router(new Request(`${PUBLIC}${path}`, init), {
        disableIdleTimeout: () => {},
      });
      if (!res) throw new Error(`router declined ${path}`);
      return res;
    },
  };
}

/** A PKCE pair. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Query string for /authorize. */
export function authorizeQuery(p: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined) q.set(k, v);
  return `/api/mcp/oauth/authorize?${q}`;
}

/** Register a DCR client for `redirectUris` and return its client_id. */
export async function registerClient(h: Harness, redirectUris: string[]): Promise<string> {
  const res = await h.send("/api/mcp/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: redirectUris,
      client_name: "Test",
      token_endpoint_auth_method: "none",
    }),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Location of a redirect as a URL. */
export function location(res: Response): URL {
  const loc = res.headers.get("location");
  if (!loc) throw new Error(`no Location (status ${res.status})`);
  return new URL(loc);
}

/**
 * Walk /authorize → Google → /google-callback and return the code the
 * client receives, plus everything else a test might inspect.
 */
export async function obtainCode(
  h: Harness,
  args: {
    clientId: string;
    redirectUri: string;
    challenge: string;
    state?: string;
    resource?: string;
  },
): Promise<{ code: string; googleState: string; clientRedirect: URL }> {
  const auth = await h.send(
    authorizeQuery({
      response_type: "code",
      client_id: args.clientId,
      redirect_uri: args.redirectUri,
      code_challenge: args.challenge,
      code_challenge_method: "S256",
      state: args.state ?? "client-state-1",
      resource: args.resource,
    }),
  );
  if (auth.status !== 302) throw new Error(`authorize: ${auth.status} ${await auth.text()}`);
  const googleState = location(auth).searchParams.get("state") ?? "";
  const cb = await h.send(
    `/api/mcp/oauth/google-callback?code=${encodeURIComponent("4/google-code")}&state=${encodeURIComponent(googleState)}`,
  );
  const clientRedirect = location(cb);
  return { code: clientRedirect.searchParams.get("code") ?? "", googleState, clientRedirect };
}

/** POST a form to /token. */
export function postToken(
  h: Harness,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return h.send("/api/mcp/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}
