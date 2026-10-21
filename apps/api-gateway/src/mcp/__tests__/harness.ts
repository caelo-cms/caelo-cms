// SPDX-License-Identifier: MPL-2.0

/**
 * Shared fakes for the remote-MCP tests (#806): a router wired to an
 * injected fetch that plays Google's token endpoint, CIMD hosts and the
 * admin, and helpers that walk the OAuth flow (consent page included) the
 * way a browser does. Test-only; not imported by the gateway.
 */

import { createHash, randomBytes } from "node:crypto";
import { AccessSealSchema } from "../access-token.js";
import type { ProxyLimits } from "../context.js";
import { GOOGLE_TOKEN_URL } from "../google.js";
import type { BucketSpec, McpRateClass } from "../rate-limit.js";
import { createMcpRouter, type McpRouter } from "../routes.js";
import { open, seal } from "../seal.js";

export const PUBLIC = "https://gw.example.com";
export const ISSUER = `${PUBLIC}/api/mcp/oauth`;
export const ADMIN = "https://admin.example.com";
export const GOOGLE_CLIENT_ID = "1234-abc.apps.googleusercontent.com";
export const GOOGLE_CLIENT_SECRET = "GOCSPX-test-secret";
export const SEAL_KEY_B64 = randomBytes(32).toString("base64");
export const CLIENT_FILE = "/secrets/operator-oauth-client/latest";
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
/** The client address every harness request comes from (unless a test says otherwise). */
export const CLIENT_IP = "198.51.100.7";

export const BASE_ENV: Record<string, string> = {
  CAELO_MCP_PUBLIC_URL: PUBLIC,
  CAELO_ADMIN_URL: ADMIN,
  CAELO_MCP_OAUTH_SEAL_KEY: SEAL_KEY_B64,
  CAELO_OPERATOR_OAUTH_CLIENT_FILE: CLIENT_FILE,
};

export const CONFIGURED_FILE = JSON.stringify({
  client_id: GOOGLE_CLIENT_ID,
  client_secret: GOOGLE_CLIENT_SECRET,
});

/** The harness clock starts here (ms). */
export const START_MS = 1_800_000_000_000;

const SEAL_KEY = new Uint8Array(Buffer.from(SEAL_KEY_B64, "base64"));

/**
 * A broker access token wrapping `idToken`, as /token mints it: bound to
 * `resource` (null = both surfaces) and issued to `client`, expiring
 * `ttlSeconds` after `nowMs`.
 */
export function accessToken(
  idToken: string,
  resource: string | null = null,
  {
    nowMs = Date.now(),
    ttlSeconds = 3600,
    client = "dcr:Test",
  }: { nowMs?: number; ttlSeconds?: number; client?: string } = {},
): string {
  return seal(SEAL_KEY, "access", {
    id_token: idToken,
    resource,
    client,
    exp: Math.floor(nowMs / 1000) + ttlSeconds,
  });
}

/** A pre-#968 access token: no client in the seal. */
export function legacyAccessToken(idToken: string, nowMs = Date.now()): string {
  return seal(SEAL_KEY, "access", {
    id_token: idToken,
    resource: null,
    exp: Math.floor(nowMs / 1000) + 3600,
  });
}

/** What an access token from /token carries (fails the test if it is not one). */
export function openAccess(
  token: string,
  nowSeconds: number,
): { id_token: string; resource: string | null; client: string; exp: number } {
  const opened = open(SEAL_KEY, "access", token, AccessSealSchema, nowSeconds);
  if (!opened.ok) throw new Error(`not a broker access token (${opened.reason})`);
  return opened.value;
}

/** An unsigned JWT shaped like a Google ID token (the broker reads, never verifies, it). */
export function fakeIdToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256", kid: "k1" })}.${part({ iss: "https://accounts.google.com", sub: "1", email: "u@example.com", ...claims })}.c2ln`;
}

export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** What a fake Google gets: the posted form and the current Unix time. */
export type GoogleFake = (
  form: URLSearchParams,
  nowSeconds: number,
) => Response | Promise<Response>;

export interface HarnessOptions {
  env?: Record<string, string | undefined>;
  clientFile?: string | (() => string);
  /** Google's token endpoint; gets the posted form. */
  google?: GoogleFake;
  /** Any other outbound URL (CIMD documents, the admin). */
  other?: (url: string, init: RequestInit) => Response | Promise<Response>;
  rateLimits?: Record<McpRateClass, BucketSpec>;
  proxyLimits?: ProxyLimits;
}

export interface Harness {
  readonly router: McpRouter;
  readonly calls: FetchCall[];
  readonly googleForms: URLSearchParams[];
  /** Move the clock (ms). */
  advance(ms: number): void;
  /** Current harness time (Unix seconds). */
  nowSeconds(): number;
  /** Send a request through the router; fails the test if the router declines it. */
  send(path: string, init?: RequestInit, clientAddress?: string): Promise<Response>;
}

/** Google's token endpoint as the broker expects it: ID token for our client, 1 h. */
export function defaultGoogle(form: URLSearchParams, nowSeconds: number): Response {
  const id_token = fakeIdToken({ aud: GOOGLE_CLIENT_ID, exp: nowSeconds + 3600 });
  if (form.get("grant_type") === "authorization_code") {
    return Response.json({
      access_token: "ya29.google-access",
      expires_in: 3599,
      token_type: "Bearer",
      refresh_token: "1//google-refresh",
      scope: "openid https://www.googleapis.com/auth/userinfo.email",
      id_token,
    });
  }
  return Response.json({
    access_token: "ya29.refreshed",
    expires_in: 3599,
    token_type: "Bearer",
    id_token: fakeIdToken({ aud: GOOGLE_CLIENT_ID, exp: nowSeconds + 3500, refreshed: true }),
  });
}

export function harness(opts: HarnessOptions = {}): Harness {
  let now = START_MS;
  const calls: FetchCall[] = [];
  const googleForms: URLSearchParams[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (url === GOOGLE_TOKEN_URL) {
      const form = new URLSearchParams(String(init.body));
      googleForms.push(form);
      return (opts.google ?? defaultGoogle)(form, Math.floor(now / 1000));
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
    ...(opts.rateLimits ? { rateLimits: opts.rateLimits } : {}),
    ...(opts.proxyLimits ? { proxyLimits: opts.proxyLimits } : {}),
  });
  return {
    router,
    calls,
    googleForms,
    advance(ms) {
      now += ms;
    },
    nowSeconds: () => Math.floor(now / 1000),
    async send(path, init, clientAddress = CLIENT_IP) {
      const res = await router(new Request(`${PUBLIC}${path}`, init), {
        clientAddress,
        setIdleTimeout: () => {},
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
export async function registerClient(
  h: Harness,
  redirectUris: string[],
  clientName = "Test",
): Promise<string> {
  const res = await h.send("/api/mcp/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: redirectUris,
      client_name: clientName,
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

/** What a consent page hands the browser: the form's token and the binding cookie. */
export interface Consent {
  /** The sealed consent token in the form. */
  readonly token: string;
  /** `name=value` of the binding cookie, as a browser would send it back. */
  readonly cookie: string;
}

/** Read the consent token and binding cookie off a consent page response. */
export async function readConsent(page: Response): Promise<Consent> {
  if (page.status !== 200) throw new Error(`consent page: ${page.status} ${await page.text()}`);
  const html = await page.text();
  const m = /name="consent" value="([^"]+)"/.exec(html);
  if (!m?.[1]) throw new Error("no consent token in the page");
  const setCookie = page.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  if (!cookie.startsWith("__Host-")) throw new Error(`no binding cookie: ${setCookie}`);
  return { token: m[1].replaceAll("&amp;", "&"), cookie };
}

/** POST the consent page's decision. */
export function decide(
  h: Harness,
  consent: { token: string; cookie: string | null },
  decision: "approve" | "deny" = "approve",
  headers: Record<string, string> = {},
): Promise<Response> {
  return h.send("/api/mcp/oauth/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: PUBLIC,
      ...(consent.cookie !== null ? { cookie: consent.cookie } : {}),
      ...headers,
    },
    body: new URLSearchParams({ consent: consent.token, decision }).toString(),
  });
}

/** Open the consent page and approve it; returns the Google redirect and the binding cookie. */
export async function approve(
  h: Harness,
  args: Record<string, string | undefined>,
): Promise<{ google: URL; googleState: string; cookie: string }> {
  const consent = await readConsent(await h.send(authorizeQuery(args)));
  const res = await decide(h, consent);
  if (res.status !== 302) throw new Error(`approve: ${res.status} ${await res.text()}`);
  const google = location(res);
  return { google, googleState: google.searchParams.get("state") ?? "", cookie: consent.cookie };
}

/**
 * Walk /authorize → consent → Google → /google-callback and return the
 * code the client receives, plus everything else a test might inspect.
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
): Promise<{ code: string; googleState: string; cookie: string; clientRedirect: URL }> {
  const { googleState, cookie } = await approve(h, {
    response_type: "code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    code_challenge: args.challenge,
    code_challenge_method: "S256",
    state: args.state ?? "client-state-1",
    resource: args.resource,
  });
  const cb = await h.send(
    `/api/mcp/oauth/google-callback?code=${encodeURIComponent("4/google-code")}&state=${encodeURIComponent(googleState)}`,
    { headers: { cookie } },
  );
  const clientRedirect = location(cb);
  return {
    code: clientRedirect.searchParams.get("code") ?? "",
    googleState,
    cookie,
    clientRedirect,
  };
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
