// SPDX-License-Identifier: MPL-2.0

/**
 * Security headers of the gateway's JSON answers (#1326, #763 L2).
 *
 * A JSON answer is data, never a document: it must not be sniffed into
 * HTML or script, framed, or handed to another origin's page. The headers
 * say so to the browser on every JSON response, whichever route produced
 * it (plugin operations, the captcha challenge, health, the remote-MCP
 * OAuth broker's JSON).
 */

/** The headers every JSON response carries. */
export const JSON_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  // Nothing in a JSON answer may load or run anything, nor be framed.
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** Whether `res` is a JSON answer (any `application/json` or `+json` type). */
export function isJsonResponse(res: Response): boolean {
  const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

/** Set the {@link JSON_SECURITY_HEADERS} on `headers`, keeping a value already set. */
export function addJsonSecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(JSON_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
}

/**
 * `res` with the JSON security headers when it is JSON, else `res` as it
 * is. A response whose headers are immutable (one passed through from a
 * `fetch`) is rebuilt around the same body stream, so a streamed answer
 * stays streamed.
 */
export function withJsonSecurityHeaders(res: Response): Response {
  if (!isJsonResponse(res)) return res;
  if (Object.keys(JSON_SECURITY_HEADERS).every((h) => res.headers.has(h))) return res;
  try {
    addJsonSecurityHeaders(res.headers);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    addJsonSecurityHeaders(headers);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}
