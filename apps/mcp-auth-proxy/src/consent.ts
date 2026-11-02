// SPDX-License-Identifier: MPL-2.0

/**
 * The broker's consent step (issue #806 follow-up): the page the user sees
 * at /authorize before Google, and the browser binding that makes its
 * Approve button and Google's callback unforgeable.
 *
 * Why a consent page at all: registration is open (DCR, CIMD) and some
 * allowlisted callbacks belong to third-party platforms where anyone can
 * own a callback id (`https://chatgpt.com/connector/oauth/<id>`). Without a
 * step on the broker's own origin, a link to /authorize would take a
 * signed-in user straight through Google (which shows the broker's static
 * client, not the requesting app) and hand a code to whoever registered
 * that client — the confused-deputy case the MCP Security Best Practices
 * call out for proxies with a static upstream client
 * (https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices#confused-deputy-problem).
 * The page names where the user will be sent back to — the host, and the
 * full redirect URI, because on a shared host such as chatgpt.com the
 * callback id in the path is what tells one connector owner from another
 * — the app's self-chosen name (labelled unverified), and what it gets
 * access to. That access is enforced, not just shown: the access token is
 * bound to the surface (access-token.ts).
 *
 * The binding: GET /authorize sets a `__Host-` cookie holding a random
 * nonce and embeds a sealed consent token carrying the same nonce plus the
 * client_id, redirect_uri, PKCE challenge and resource. Approve is a POST
 * of that token; it is honoured only when the browser presents the
 * matching cookie (double submit), so a page elsewhere cannot approve on
 * the user's behalf — it can get a token by fetching /authorize itself, but
 * never the user's cookie. The Google `state` carries the binding on, and
 * /google-callback refuses a state whose cookie this browser does not
 * hold, so a sign-in cannot be finished in a browser that did not approve
 * it. The cookie is `SameSite=Lax`: sent on Google's top-level redirect
 * back, not on a cross-site POST. Each sign-in gets its own cookie name, so
 * two parallel sign-ins (chat and admin connectors) do not clobber each
 * other; each expires within {@link CONSENT_COOKIE_MAX_AGE_SECONDS} and the
 * callback deletes it.
 *
 * The page is static HTML: every interpolated value is escaped, there is
 * no script, the one stylesheet is pinned by hash in the CSP, and
 * `frame-ancestors 'none'` keeps it out of frames (clickjacking).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MCP_SURFACE_COPY, MCP_SURFACE_PERMISSION } from "@caelo-cms/shared";
import type { McpConfig, McpSurface } from "./config.js";
import { resourceUrl } from "./context.js";
import { GOOGLE_AUTHORIZE_URL } from "./google.js";

/** Lifetime of the consent token on the page (the user reads, then clicks). */
export const CONSENT_TTL_SECONDS = 10 * 60;

/**
 * The cookie must outlive the consent page and the Google leg after it
 * (STATE_TTL_SECONDS, also 10 min), so: both together.
 */
export const CONSENT_COOKIE_MAX_AGE_SECONDS = 20 * 60;

const COOKIE_PREFIX = "__Host-caelo-mcp-consent-";

/** The browser binding of one sign-in: which cookie, and the nonce it must hold. */
export interface ConsentBinding {
  /** Suffix of the cookie name (16 hex chars). */
  readonly id: string;
  /** The cookie's value (32 random bytes, base64url). */
  readonly nonce: string;
}

/** A fresh binding for a new sign-in. */
export function newBinding(): ConsentBinding {
  return {
    id: randomBytes(8).toString("hex"),
    nonce: randomBytes(32).toString("base64url"),
  };
}

/** The `Set-Cookie` that starts a binding. */
export function bindingCookie(b: ConsentBinding): string {
  return `${COOKIE_PREFIX}${b.id}=${b.nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${CONSENT_COOKIE_MAX_AGE_SECONDS}`;
}

/** The `Set-Cookie` that ends a binding (after the callback used it). */
export function clearBindingCookie(id: string): string {
  return `${COOKIE_PREFIX}${id}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** True when `req` carries the cookie of binding `id` with exactly `nonce`. */
export function requestHoldsBinding(req: Request, id: string, nonce: string): boolean {
  const name = `${COOKIE_PREFIX}${id}`;
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const got = Buffer.from(part.slice(eq + 1).trim(), "utf8");
    const want = Buffer.from(nonce, "utf8");
    if (got.byteLength === want.byteLength && timingSafeEqual(got, want)) return true;
  }
  return false;
}

/** HTML-escape text for element content and double-quoted attributes. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
h1{font-size:1.4rem}dl{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1rem}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}
.warn{color:#8a4b00}form{display:flex;gap:.75rem;margin-top:2rem}button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #888;background:#f4f4f4;cursor:pointer}
button[value=approve]{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
@media (prefers-color-scheme:dark){body{background:#141414;color:#eee}.warn{color:#f0b060}button{background:#2a2a2a;color:#eee}button[value=approve]{background:#eee;color:#141414}}`;

const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

/** Where the redirect URI sends the user, in words a person can check. */
function describeRedirect(redirectUri: string): { target: string; note: string | null } {
  const u = new URL(redirectUri);
  if (u.protocol === "http:") {
    return { target: `${u.protocol}//${u.host}`, note: "an app running on this computer" };
  }
  return { target: `${u.protocol}//${u.host}`, note: null };
}

/** The CSP `form-action` source of the redirect URI (Deny redirects there). */
function formActionSource(redirectUri: string): string {
  const u = new URL(redirectUri);
  return u.protocol === "http:" || u.protocol === "https:" ? u.origin : u.protocol;
}

function surfaceOf(config: McpConfig, resource: string | null): McpSurface | null {
  if (resource === resourceUrl(config, "chat")) return "chat";
  if (resource === resourceUrl(config, "admin")) return "admin";
  return null;
}

/**
 * What the grant opens, in the words Settings → MCP uses for the two
 * addresses (`MCP_SURFACE_COPY`, #968), plus who may use it: the broker
 * cannot know the user's role before Google sign-in, so the page says up
 * front which role the address needs instead of failing silently after.
 */
const ACCESS: Record<McpSurface | "both", { label: string; detail: string }> = {
  chat: {
    label: MCP_SURFACE_COPY.chat.title,
    detail: `${MCP_SURFACE_COPY.chat.does} Needs a role on this site that may edit content (${MCP_SURFACE_PERMISSION.chat}).`,
  },
  admin: {
    label: MCP_SURFACE_COPY.admin.title,
    detail: `${MCP_SURFACE_COPY.admin.does} Needs a role on this site that may change settings (${MCP_SURFACE_PERMISSION.admin}); with any other role, use the chat address instead.`,
  },
  both: {
    label: `${MCP_SURFACE_COPY.chat.title} and ${MCP_SURFACE_COPY.admin.title.toLowerCase()}`,
    detail: `Each works only if your role on this site allows it: chat needs ${MCP_SURFACE_PERMISSION.chat}, full admin access needs ${MCP_SURFACE_PERMISSION.admin}.`,
  },
};

/** Everything the consent page shows and submits. */
export interface ConsentPage {
  readonly config: McpConfig;
  readonly clientName: string | null;
  readonly redirectUri: string;
  readonly resource: string | null;
  /** The sealed consent token the form posts back. */
  readonly consentToken: string;
  readonly binding: ConsentBinding;
}

/** The consent page response (200 HTML, sets the binding cookie). */
export function consentPage(p: ConsentPage): Response {
  const site = new URL(p.config.publicUrl).host;
  const redirect = describeRedirect(p.redirectUri);
  const access = ACCESS[surfaceOf(p.config, p.resource) ?? "both"];
  const name =
    p.clientName !== null && p.clientName.trim() !== ""
      ? `${escapeHtml(p.clientName)} <span class="warn">(name not verified)</span>`
      : `<span class="warn">An app that did not give its name</span>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin"><title>Connect an app to ${escapeHtml(site)}</title><style>${STYLE}</style></head>
<body><main>
<h1>Connect an app to ${escapeHtml(site)}?</h1>
<p>An app wants to use this Caelo site on your behalf. Only continue if you just started connecting it yourself.</p>
<dl>
<dt>App</dt><dd>${name}</dd>
<dt>Sends you back to</dt><dd><strong>${escapeHtml(redirect.target)}</strong>${redirect.note ? ` (${escapeHtml(redirect.note)})` : ""}<br><code>${escapeHtml(p.redirectUri)}</code></dd>
<dt>Gets access to</dt><dd><strong>${escapeHtml(access.label)}</strong>, as you<br>${escapeHtml(access.detail)}</dd>
</dl>
<p>If you approve, Google asks you to sign in next. The app can then act with your Caelo permissions until you disconnect it.</p>
<form method="post" action="/api/mcp/oauth/authorize">
<input type="hidden" name="consent" value="${escapeHtml(p.consentToken)}">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</main></body></html>
`;
  const csp = [
    "default-src 'none'",
    `style-src 'sha256-${STYLE_HASH}'`,
    // The Approve POST redirects to Google, Deny to the client; browsers
    // check form-action on the redirect target too.
    `form-action 'self' ${new URL(GOOGLE_AUTHORIZE_URL).origin} ${formActionSource(p.redirectUri)}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      // same-origin, not no-referrer: a form POST under no-referrer sends
      // `Origin: null`, which would hide that the approval came from here.
      "referrer-policy": "same-origin",
      "cache-control": "no-store",
      "set-cookie": bindingCookie(p.binding),
    },
  });
}
