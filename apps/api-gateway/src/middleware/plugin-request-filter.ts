// SPDX-License-Identifier: MPL-2.0

/**
 * The cheap checks a `/api/plugin/*` request must pass before the gateway
 * reads its body or touches the database (#1326, #763 M1/M9).
 *
 *   - **Path:** `/api/plugin/<slug>/<operation>` with the lengths the op
 *     event table allows (slug ≤ 64, operation ≤ 120), so an invented name
 *     of any length is refused by a bounded regex, not looked up.
 *   - **Content-Type:** `application/json` only. A browser sends a
 *     cross-site form or a `text/plain` fetch without a preflight; JSON is
 *     what the site's own components post (plugin-component-kit
 *     `postPluginJson`).
 *   - **Origin:** must be one of the live site's origins, as the admin
 *     publishes them (`published_gateway_settings.live_origins`, from the
 *     base URL and the public domains). The staging origin is never one:
 *     staging is same-site with live, so `SameSite` cookies and
 *     `Sec-Fetch-Site` let it through, and unreviewed module JS staged
 *     there must not post into the live data (#763 N4). A request without
 *     `Origin` is refused too: every browser sends it on a POST, and a
 *     non-browser client has no business on these routes.
 */

/** `/api/plugin/<slug>/<operation>`, bounded like `gateway_plugin_op_events.operation`. */
export const PLUGIN_PATH_RE = /^\/api\/plugin\/([a-z][a-z0-9-]{0,63})\/([a-z_][a-z0-9_]{0,119})$/;

/** Why a plugin request was refused before dispatch. */
export type PluginRequestRefusal =
  | { readonly kind: "UnsupportedMediaType"; readonly status: 415 }
  | { readonly kind: "OriginNotAllowed"; readonly status: 403 };

/** The slug and operation a plugin path names, or null when it names none. */
export function parsePluginPath(pathname: string): { slug: string; operation: string } | null {
  const m = PLUGIN_PATH_RE.exec(pathname);
  return m?.[1] && m[2] ? { slug: m[1], operation: m[2] } : null;
}

/** Whether `contentType` is JSON (`application/json`, any parameters). */
export function isJsonContentType(contentType: string | null): boolean {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * Check `req`'s headers against the rules above.
 *
 * @param liveOrigins the live site's origins (`https://example.com`).
 * @returns null when the request may proceed, else the refusal.
 */
export function refusePluginRequest(
  req: Request,
  liveOrigins: readonly string[],
): PluginRequestRefusal | null {
  if (!isJsonContentType(req.headers.get("content-type"))) {
    return { kind: "UnsupportedMediaType", status: 415 };
  }
  const origin = req.headers.get("origin");
  if (!origin || !liveOrigins.includes(origin.toLowerCase())) {
    return { kind: "OriginNotAllowed", status: 403 };
  }
  return null;
}
