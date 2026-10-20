// SPDX-License-Identifier: MPL-2.0

/**
 * The redirect URIs the OAuth broker will ever send an authorization code
 * to (issue #806).
 *
 * Why an allowlist on top of client registration: registration here is
 * open (stateless DCR, CIMD), so "the client registered it" proves
 * nothing. A code sent to an attacker's URL is a Google access token for
 * the victim's account a moment later. The broker therefore only ever
 * redirects to the callbacks of the MCP clients Caelo supports, or to the
 * user's own machine (RFC 8252 loopback).
 *
 * Matching is on the raw string: exact for fixed callbacks, an anchored
 * pattern for the two documented families (ChatGPT callback ids,
 * loopback). No host wildcards, no fragments, no query, no userinfo, no
 * case folding, no percent-decoding — `https://Claude.ai/…`,
 * `https://claude.ai.evil.com/…`, `https://claude.ai@evil.com/…` and
 * `https://claude.ai%2F@evil.com/` all fail.
 *
 * Sources (checked 2026-10-19):
 *   - Claude: https://claude.com/docs/connectors/building/authentication
 *     (hosted callback; Claude Code loopback on any port, `localhost` and
 *     `127.0.0.1`, CIMD declares them without a port).
 *   - ChatGPT: https://developers.openai.com/apps-sdk/build/auth (stable
 *     `connector_platform_oauth_redirect` when the AS returns `iss`,
 *     otherwise `connector/oauth/{callback_id}`).
 *   - VS Code: microsoft/vscode#278512 (DCR registers vscode.dev and
 *     insiders.vscode.dev `/redirect` plus `http://127.0.0.1[:33418]/`).
 *   - Cursor: forum.cursor.com/t/165019, staff answer 2026-07-15 (the
 *     `cursor://anysphere.cursor-mcp/oauth/callback` scheme,
 *     `https://www.cursor.com/agents/mcp/oauth/callback`, and the loopback
 *     `http://localhost:8787/callback`).
 */

/** Fixed callbacks, matched byte for byte. */
export const REDIRECT_URI_ALLOWLIST: readonly string[] = [
  // Claude (claude.ai web, Desktop, mobile, Cowork); claude.com is the same app's newer host.
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  // ChatGPT, for an AS that advertises and returns `iss` (this one does).
  "https://chatgpt.com/connector_platform_oauth_redirect",
  // VS Code on the web / desktop (via vscode.dev) and Insiders. These pages
  // forward the code to the URL in `state`, which whoever starts the flow
  // chooses — so they are only safe if that forward cannot leave the
  // user's machine. Probed 2026-10-19 (vscode.dev x-commit 514b2709): it
  // 302s only to `vscode:` / `vscode-insiders:` URLs and to
  // `http(s)://127.0.0.1` / `http://localhost`; every other target
  // (`https://evil.example/`, `http://127.0.0.1@evil.com/`,
  // `http://127.0.0.1.evil.com/`, other schemes) ends at a 400
  // "Unsupported redirect target"; insiders.vscode.dev behaves the same. If
  // a probe ever shows otherwise, both entries go. A code reaching the user's own VS Code
  // or loopback is the same exposure as the loopback entries below.
  "https://vscode.dev/redirect",
  "https://insiders.vscode.dev/redirect",
  // Cursor: the app's URL scheme and its hosted agents.
  "cursor://anysphere.cursor-mcp/oauth/callback",
  "https://www.cursor.com/agents/mcp/oauth/callback",
];

/** ChatGPT's per-connector callback, for clients that do not rely on `iss`. */
const CHATGPT_CALLBACK_ID = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;

/**
 * RFC 8252 §7.3 loopback: `http`, a loopback host, an optional port
 * (1–65535, no leading zero), and an optional path of plain path
 * characters. No query, no fragment, no `@` — the path cannot reopen the
 * authority. Claude Code, Cursor, VS Code and Codex use it.
 */
const LOOPBACK =
  /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::([1-9][0-9]{0,4}))?(\/[A-Za-z0-9._~!$&'()*+,;=:%/-]*)?$/;

/** A parsed loopback redirect URI. */
interface Loopback {
  readonly host: string;
  readonly port: number | null;
  /** Path, `/` when absent (the URL a browser follows is the same). */
  readonly path: string;
}

function parseLoopback(uri: string): Loopback | null {
  const m = LOOPBACK.exec(uri);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : null;
  if (port !== null && port > 65535) return null;
  const path = m[3] ?? "/";
  // `%` only as a complete escape; never an encoded slash, dot or backslash
  // that a client might decode into a different path.
  if (/%(?![0-9A-Fa-f]{2})/.test(path) || /%(2[fF]|2[eE]|5[cC])/.test(path)) return null;
  return { host: m[1] as string, port, path };
}

/** True when `uri` is one the broker may redirect a code to. */
export function isAllowedRedirectUri(uri: string): boolean {
  if (uri.length > 2048) return false;
  if (REDIRECT_URI_ALLOWLIST.includes(uri)) return true;
  if (CHATGPT_CALLBACK_ID.test(uri)) return true;
  return parseLoopback(uri) !== null;
}

/**
 * True when the redirect URI of an authorization request matches one the
 * client registered. Exact string comparison, except that loopback URIs
 * ignore the port (RFC 8252 §7.3: a native app picks a free port per
 * session, and Claude Code's CIMD lists `http://localhost/callback`
 * without one). The requested URI must also pass
 * {@link isAllowedRedirectUri}, whatever the client registered.
 */
export function redirectUriMatches(requested: string, registered: readonly string[]): boolean {
  if (!isAllowedRedirectUri(requested)) return false;
  const req = parseLoopback(requested);
  for (const r of registered) {
    if (r === requested) return true;
    if (!req) continue;
    const reg = parseLoopback(r);
    if (reg && reg.host === req.host && reg.path === req.path) return true;
  }
  return false;
}
