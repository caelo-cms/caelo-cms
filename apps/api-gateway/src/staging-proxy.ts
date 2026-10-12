// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #650 — `staging.<domain>` on gcp-firebase: the access gate plus a
 * transparent reverse proxy to the current staged build.
 *
 * Firebase Hosting has no access control and a preview channel is public
 * by URL, so the gateway (already a public Cloud Run service, scaled to
 * zero when idle) serves the staging host instead, mapped to it with a
 * Cloud Run domain mapping (`cms-provision staging-domain enable`):
 *
 *   1. `/_caelo/staging-access?t=<token>&next=<path>` — the admin's "Open
 *      staging" link. A valid, unexpired token becomes the staging session
 *      cookie (HttpOnly, Secure, 12 h) and a redirect to `next`.
 *   2. Every other request passes the gate (@caelo-cms/shared
 *      staging-gate.ts): session cookie, basic auth, secret header or IP
 *      allowlist — any one enabled and satisfied. Otherwise 401 with
 *      `WWW-Authenticate: Basic` when basic auth is on, else 403 with a
 *      short page pointing to the admin.
 *   3. An admitted request is forwarded to the preview channel the admin
 *      recorded for the current Stage (`staging_access.origin_url`), and the
 *      answer comes back unchanged — status, redirects (their Location
 *      re-addressed from the preview origin to the staging host), headers,
 *      compressed body — so staging behaves exactly like Hosting serves the
 *      release that goes live. `X-Robots-Tag: noindex` is guaranteed.
 *
 * The gate's own credentials never reach the origin: the Authorization
 * header (when it carried the staging login), the secret header and the
 * session cookie are removed before forwarding.
 *
 * The quality audit does NOT come through here — it loads the preview
 * channel directly, so a cold gateway never skews performance scores.
 */

import {
  decideStagingAccess,
  parseBasicAuthorization,
  STAGING_ACCESS_PATH,
  STAGING_SESSION_COOKIE,
  STAGING_SESSION_TTL_SECONDS,
  type StagingAccessSettings,
  safeStagingNextPath,
  signStagingToken,
  verifyStagingToken,
} from "@caelo-cms/shared";

/** The staging host this gateway serves and the gate's shared key. */
export interface StagingGateConfig {
  /** `https://staging.<domain>` (no trailing slash). */
  readonly stagingOrigin: string;
  /** `CAELO_STAGING_GATE_SECRET`; null when the deployment lacks it. */
  readonly secret: string | null;
}

/** What the gate needs from the database, cached briefly by the caller. */
export interface StagingState {
  readonly settings: StagingAccessSettings;
  /** Origin of the current staged build (the preview channel); null when nothing is staged. */
  readonly originUrl: string | null;
}

export interface StagingProxyDeps {
  readonly config: StagingGateConfig;
  readonly loadState: () => Promise<StagingState>;
  /** Upstream fetch (tests pass a fake). */
  readonly fetchImpl?: typeof fetch;
  readonly nowSeconds?: () => number;
}

/**
 * The staging gate's configuration from the gateway env, or null when this
 * gateway serves no staging host (every provider but gcp-firebase).
 */
export function stagingGateConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): StagingGateConfig | null {
  const raw = env.CAELO_STAGING_SITE_URL;
  if (!raw) return null;
  return {
    stagingOrigin: new URL(raw).origin,
    secret: env.CAELO_STAGING_GATE_SECRET || null,
  };
}

/** True when `req` is addressed to the staging host. */
export function isStagingRequest(req: Request, stagingOrigin: string): boolean {
  const host = (req.headers.get("host") ?? new URL(req.url).host).toLowerCase();
  return host === new URL(stagingOrigin).host.toLowerCase();
}

/**
 * The client address Cloud Run vouches for: the LAST `X-Forwarded-For`
 * entry. Google's front end appends the address it received the
 * connection from; anything before it came from the client and can be
 * forged, so an allowlist must never trust the first entry.
 */
export function cloudRunClientIp(xForwardedFor: string | null): string | null {
  if (!xForwardedFor) return null;
  const last = xForwardedFor.split(",").at(-1)?.trim();
  return last ? last : null;
}

/**
 * Re-address a redirect from the preview origin to the staging host. A
 * Location on any other origin (or relative) is returned unchanged.
 */
export function rewriteLocation(
  location: string,
  previewOrigin: string,
  stagingOrigin: string,
): string {
  let url: URL;
  try {
    url = new URL(location, previewOrigin);
  } catch {
    return location;
  }
  if (url.origin !== new URL(previewOrigin).origin) return location;
  // Relative Locations stay relative: they already resolve on the staging host.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(location) && !location.startsWith("//")) return location;
  return `${stagingOrigin}${url.pathname}${url.search}${url.hash}`;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function gatePage(status: number, title: string, body: string, extra: HeadersInit = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#222}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  const headers = new Headers(extra);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex");
  return new Response(html, { status, headers });
}

function sessionCookie(token: string): string {
  return [
    `${STAGING_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${STAGING_SESSION_TTL_SECONDS}`,
  ].join("; ");
}

/** The request's Cookie header without the staging session cookie (null when nothing is left). */
function cookiesWithoutSession(header: string | null): string | null {
  if (!header) return null;
  const kept = header
    .split(/;\s*/)
    .filter((p) => p.length > 0 && p.slice(0, p.indexOf("=")).trim() !== STAGING_SESSION_COOKIE);
  return kept.length > 0 ? kept.join("; ") : null;
}

function upstreamHeaders(req: Request, settings: StagingAccessSettings, stagingHost: string) {
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    const n = name.toLowerCase();
    if (HOP_BY_HOP.has(n) || n === "host" || n === "cookie" || n === "content-length") continue;
    // The gate's own credentials stay at the gate.
    if (n === settings.headerName.toLowerCase()) continue;
    if (n === "authorization" && parseBasicAuthorization(value)?.user === settings.basicAuthUser) {
      continue;
    }
    headers.set(name, value);
  }
  const cookies = cookiesWithoutSession(req.headers.get("cookie"));
  if (cookies) headers.set("cookie", cookies);
  headers.set("x-forwarded-host", stagingHost);
  headers.set("x-forwarded-proto", "https");
  return headers;
}

async function proxy(
  req: Request,
  state: StagingState & { originUrl: string },
  config: StagingGateConfig,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const url = new URL(req.url);
  const origin = new URL(state.originUrl).origin;
  const target = `${origin}${url.pathname}${url.search}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: req.method,
      headers: upstreamHeaders(req, state.settings, new URL(config.stagingOrigin).host),
      ...(hasBody ? { body: req.body, duplex: "half" } : {}),
      redirect: "manual",
      // Pass the origin's encoded bytes through untouched: decoding here
      // would change Content-Encoding/Length versus what Hosting serves.
      decompress: false,
    } as RequestInit);
  } catch (e) {
    console.error(
      `[api-gateway] staging origin unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
    return gatePage(
      502,
      "Staging is unreachable",
      "The staged build could not be loaded. Try again in a moment; if it persists, Stage again from the Caelo admin.",
    );
  }
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    const n = name.toLowerCase();
    if (HOP_BY_HOP.has(n) || n === "set-cookie") continue;
    headers.append(name, value);
  }
  for (const c of upstream.headers.getSetCookie()) headers.append("set-cookie", c);
  const location = upstream.headers.get("location");
  if (location) headers.set("location", rewriteLocation(location, origin, config.stagingOrigin));
  const robots = headers.get("x-robots-tag");
  if (!robots || !/noindex/i.test(robots)) {
    headers.set("x-robots-tag", robots ? `${robots}, noindex` : "noindex");
  }
  return new Response(req.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** Serve one request addressed to the staging host. */
export async function handleStagingRequest(
  req: Request,
  deps: StagingProxyDeps,
): Promise<Response> {
  const { config } = deps;
  if (!config.secret) {
    return gatePage(
      503,
      "Staging is not configured",
      "This gateway has no staging gate key (CAELO_STAGING_GATE_SECRET). The operator runs <code>cms-provision upgrade</code> to set it.",
    );
  }
  const secret = config.secret;
  const now = (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  let state: StagingState;
  try {
    state = await deps.loadState();
  } catch (e) {
    console.error(
      `[api-gateway] staging access settings unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
    return gatePage(503, "Staging is unavailable", "Try again in a moment.");
  }
  const url = new URL(req.url);

  if (url.pathname === STAGING_ACCESS_PATH) {
    const token = url.searchParams.get("t") ?? "";
    const valid =
      req.method === "GET" &&
      state.settings.cookieEnabled &&
      (await verifyStagingToken(secret, token, "open", now));
    if (!valid) {
      return gatePage(
        403,
        "This staging link has expired",
        "Staging links from the admin work for two minutes. Open staging again from the Caelo admin.",
      );
    }
    const session = await signStagingToken(secret, "session", now + STAGING_SESSION_TTL_SECONDS);
    return new Response(null, {
      status: 303,
      headers: {
        Location: safeStagingNextPath(url.searchParams.get("next")),
        "Set-Cookie": sessionCookie(session),
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  const decision = await decideStagingAccess({
    settings: state.settings,
    secret,
    nowSeconds: now,
    request: {
      cookieHeader: req.headers.get("cookie"),
      authorizationHeader: req.headers.get("authorization"),
      header: (name) => req.headers.get(name),
      clientIp: cloudRunClientIp(req.headers.get("x-forwarded-for")),
    },
  });
  if (!decision.allowed) {
    if (decision.status === 401) {
      return gatePage(
        401,
        "Staging login required",
        "Log in with the staging credentials, or open staging from the Caelo admin.",
        { "WWW-Authenticate": 'Basic realm="Caelo staging", charset="UTF-8"' },
      );
    }
    return gatePage(
      403,
      "This is a protected staging site",
      "It shows unpublished changes. Open it from the Caelo admin (Open staging); crawlers and tools use the access configured under Security → Staging access.",
    );
  }
  if (state.originUrl === null) {
    return gatePage(
      503,
      "Nothing is staged right now",
      "The last staged build has been published live. Stage changes in the Caelo admin to see them here.",
    );
  }
  return proxy(req, { ...state, originUrl: state.originUrl }, config, deps.fetchImpl ?? fetch);
}
