// SPDX-License-Identifier: MPL-2.0

/**
 * Cookies for the sandboxed page preview, kept across reloads.
 *
 * The editor's preview runs in an opaque-origin sandbox (#946), where
 * `document.cookie` throws. Every cookie the previewed site sets — the
 * consent banner's decision first of all — was therefore gone on the next
 * load, and the banner asked again after every reload. The site behaves
 * differently in the preview than for a visitor, and the operator clicks
 * the same banner away over and over.
 *
 * So the preview gets a cookie jar of its own:
 *
 * - `previewCookieShimScript` runs first in the preview's `<head>` and,
 *   only where the native `document.cookie` throws, replaces it with an
 *   in-memory jar seeded from the server. A set or delete updates the jar
 *   and posts the whole jar to the editor (`caelo:cookies`, on the
 *   editor's channel like every other preview message).
 * - The editor stores the jar in `PREVIEW_COOKIE_JAR`, a cookie of the
 *   admin origin scoped to the preview routes (`persistPreviewCookies`).
 * - The preview route reads that cookie and seeds the next document's jar.
 *
 * The jar is written by the site's own (untrusted) scripts, so it is
 * bounded by `previewCookieJarSchema` on both sides and reaches the
 * preview again only as escaped JSON inside the sandbox. It never mixes
 * with the operator's session: a separate name, the preview path only,
 * and the opaque origin still has no access to any admin cookie. One jar
 * for the whole preview; a cookie's own path, domain and lifetime are
 * not modelled (a past expiry or `max-age<=0` deletes it).
 */

import { z } from "zod";

/** Admin-origin cookie that holds the preview's jar between loads. */
export const PREVIEW_COOKIE_JAR = "caelo_preview_jar";

/** Only the preview documents need it; `/edit/` covers both preview routes. */
export const PREVIEW_COOKIE_JAR_PATH = "/edit/";

/** Encoded size the browser stores reliably in one cookie (limit is 4096 incl. name). */
export const PREVIEW_COOKIE_JAR_MAX_BYTES = 3800;

const MAX_COOKIES = 50;
const MAX_NAME_LENGTH = 256;
const COOKIE_NAME_RE = /^[^=;,\s]+$/;

/**
 * The jar: cookie name → value, bounded like a browser bounds one site's
 * cookies. The shim applies the same bounds before it posts, so the jar it
 * sends always passes (a rejected message would leave the stored jar stale).
 */
export const previewCookieJarSchema = z
  .record(
    z.string().min(1).max(MAX_NAME_LENGTH).regex(COOKIE_NAME_RE),
    z.string().max(PREVIEW_COOKIE_JAR_MAX_BYTES),
  )
  .refine((jar) => Object.keys(jar).length <= MAX_COOKIES, {
    message: `at most ${MAX_COOKIES} preview cookies`,
  });

export type PreviewCookieJar = z.infer<typeof previewCookieJarSchema>;

/**
 * The jar stored in the admin cookie (already URI-decoded by SvelteKit),
 * or an empty jar when there is none. A cookie that does not parse is
 * reported and ignored: its content comes from the preview's scripts,
 * and a broken jar must not break the preview.
 */
export function readPreviewCookieJar(raw: string | undefined): PreviewCookieJar {
  if (raw === undefined || raw === "") return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.warn(
      `[preview-cookies] ${PREVIEW_COOKIE_JAR} is not JSON; the preview starts without cookies`,
    );
    return {};
  }
  const parsed = previewCookieJarSchema.safeParse(json);
  if (!parsed.success) {
    console.warn(
      `[preview-cookies] ${PREVIEW_COOKIE_JAR} does not match the jar shape (${parsed.error.issues[0]?.message}); the preview starts without cookies`,
    );
    return {};
  }
  return parsed.data;
}

/**
 * The jar as JSON for an inline script: `<` and the JS line separators
 * escaped, so no value can end the `<script>` element.
 */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The `<script>` that gives the sandboxed preview a working
 * `document.cookie`, seeded with `jar`. Plain browser JS, no template
 * literals inside.
 */
export function previewCookieShimScript(jar: PreviewCookieJar): string {
  return `<script data-caelo-preview-cookies>(function () {
  try {
    void document.cookie;
    return;
  } catch (e) {}
  var jar = ${inlineJson(jar)};
  var NAME_RE = ${COOKIE_NAME_RE.toString()};
  var MAX_NAME = ${MAX_NAME_LENGTH};
  var MAX_VALUE = ${PREVIEW_COOKIE_JAR_MAX_BYTES};
  var MAX_COOKIES = ${MAX_COOKIES};
  var channel = new URLSearchParams(location.search).get("channel");
  if (channel && !/^[0-9a-f-]{36}$/.test(channel)) channel = null;
  function save() {
    if (!channel || window.parent === window) return;
    parent.postMessage({ kind: "caelo:cookies", channel: channel, cookies: jar }, location.origin);
  }
  function expired(attrs) {
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i].trim();
      var eq = a.indexOf("=");
      if (eq < 0) continue;
      var key = a.slice(0, eq).trim().toLowerCase();
      var val = a.slice(eq + 1).trim();
      if (key === "max-age" && Number(val) <= 0) return true;
      if (key === "expires") {
        var t = Date.parse(val);
        if (!isNaN(t) && t <= Date.now()) return true;
      }
    }
    return false;
  }
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: function () {
      var out = [];
      for (var name in jar) {
        if (Object.prototype.hasOwnProperty.call(jar, name)) out.push(name + "=" + jar[name]);
      }
      return out.join("; ");
    },
    set: function (v) {
      var parts = String(v).split(";");
      var first = parts[0];
      var eq = first.indexOf("=");
      if (eq < 1) return;
      var name = first.slice(0, eq).trim();
      var value = first.slice(eq + 1).trim();
      var has = Object.prototype.hasOwnProperty.call(jar, name);
      if (expired(parts.slice(1))) {
        if (!has) return;
        delete jar[name];
      } else {
        // Out of bounds: dropped, as a browser drops an oversized cookie.
        if (!NAME_RE.test(name) || name.length > MAX_NAME || value.length > MAX_VALUE) {
          console.warn("[caelo-preview-cookies] cookie " + name.slice(0, 64) + " exceeds the preview's limits; not stored");
          return;
        }
        if (!has && Object.keys(jar).length >= MAX_COOKIES) {
          console.warn("[caelo-preview-cookies] the preview keeps at most " + MAX_COOKIES + " cookies; " + name.slice(0, 64) + " not stored");
          return;
        }
        jar[name] = value;
      }
      save();
    },
  });
})();</script>`;
}

const HEAD_OPEN_RE = /<head(\s[^>]*)?>/i;

/**
 * Insert the cookie shim as the first thing in `<head>` (prepended when
 * the page has none), so it runs before any script of the page reads a
 * cookie. Replacer function: a replacement string would expand `$&`.
 */
export function injectPreviewCookieShim(html: string, jar: PreviewCookieJar): string {
  const script = previewCookieShimScript(jar);
  return HEAD_OPEN_RE.test(html)
    ? html.replace(HEAD_OPEN_RE, (head) => `${head}${script}`)
    : script + html;
}

/**
 * Store the preview's jar for its next load (editor side, admin origin).
 * An empty jar clears the cookie. A jar too large for one cookie is
 * reported and cleared too, so the next load does not restore an older
 * state than the one the page last had.
 */
export function persistPreviewCookies(jar: PreviewCookieJar): void {
  const attrs = `;path=${PREVIEW_COOKIE_JAR_PATH};samesite=strict${location.protocol === "https:" ? ";secure" : ""}`;
  let value = Object.keys(jar).length === 0 ? "" : encodeURIComponent(JSON.stringify(jar));
  if (value.length > PREVIEW_COOKIE_JAR_MAX_BYTES) {
    console.warn(
      `[preview-cookies] the preview's cookies are ${value.length} bytes encoded (limit ${PREVIEW_COOKIE_JAR_MAX_BYTES}); they are not kept across reloads`,
    );
    value = "";
  }
  const lifetime = value === "" ? 0 : 365 * 24 * 60 * 60;
  // biome-ignore lint/suspicious/noDocumentCookie: a synchronous write before the next preview load; the Cookie Store API is async
  document.cookie = `${PREVIEW_COOKIE_JAR}=${value}${attrs};max-age=${lifetime}`;
}
