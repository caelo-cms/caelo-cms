// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #946 — how the admin serves a page preview (module HTML, which is
 * AI-authored or imported from third-party sites and may carry scripts).
 *
 * The invariant: **preview content never runs script in the admin
 * origin.** Before #946 the editor framed previews with
 * a sandbox of `allow-scripts` PLUS `allow-same-origin` (or none), so any
 * `<script>` in a module ran as the operator — it could read
 * `parent.document` (CSRF token included), call admin endpoints with the
 * session cookie and drive the chat. Now:
 *
 * - Every preview DOCUMENT is answered with `PREVIEW_DOCUMENT_CSP`
 *   (`sandbox allow-scripts`): the page's scripts run, but in an opaque
 *   origin — wherever the document renders, inside the editor's iframe
 *   (which carries the same sandbox attribute) or opened directly in a
 *   tab. The editor talks to it only over the channel-checked postMessage
 *   protocol (`iframe-protocol.ts`).
 * - `Referrer-Policy: no-referrer` keeps the preview URL (branch id, the
 *   editor's message channel) away from external sites the preview links to.
 * - The opaque origin's requests do not carry the Lax session cookie. Media
 *   loads through a read-only grant cookie (`preview-asset-grant.ts`);
 *   fonts are CORS loads, which an opaque origin makes WITHOUT credentials,
 *   so `inlinePreviewFonts` embeds them as `data:` URIs.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultFontsCacheDir } from "@caelo-cms/admin-core";
import { isPinnedFontSliceFile } from "@caelo-cms/shared";
import type { Cookies } from "@sveltejs/kit";
import { setPreviewAssetGrant } from "./preview-asset-grant.js";

/** CSP of every script-running preview document: scripts yes, admin origin no. */
export const PREVIEW_DOCUMENT_CSP = "sandbox allow-scripts";

/**
 * CSP of a staged-build page proxied from the admin origin
 * (`/_staging-preview`). Opened top-level and clicked through like the real
 * site, its assets load through the identity proxy with the operator's
 * cookies — so it keeps its origin and runs NO script instead (staged JS
 * runs on the staging host, not in the admin).
 */
export const STAGED_DOCUMENT_CSP =
  "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox; script-src 'none'";

/**
 * The response for one sandboxed preview document: fonts inlined, the
 * sandbox headers set, and — for a logged-in operator — the read-only media
 * grant refreshed.
 *
 * @param grant - the operator the media grant is minted for; null for a
 *   caller with its own asset credential (the screenshot capture token).
 */
export async function previewDocumentResponse(
  html: string,
  grant: { readonly cookies: Cookies; readonly userId: string } | null,
): Promise<Response> {
  if (grant) await setPreviewAssetGrant(grant.cookies, grant.userId);
  return new Response(await inlinePreviewFonts(html), { headers: previewDocumentHeaders() });
}

/** Response headers of a preview document served from the admin origin. */
export function previewDocumentHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": PREVIEW_DOCUMENT_CSP,
    "x-frame-options": "SAMEORIGIN",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

const FAMILY_RE = /^[a-z0-9-]{1,80}$/;
const FILE_RE = /^[a-f0-9]{16}\.woff2$/;

/**
 * The disk-cache path of one `/_caelo/fonts/<family>/<file>` face, or null
 * when the name is not a cache file name (path traversal is excluded by
 * these patterns, not by fs checks). Shared by the font route and
 * `inlinePreviewFonts`.
 */
export function fontCacheFile(family: string, file: string): string | null {
  if (!FAMILY_RE.test(family)) return null;
  // Registry-derived slices share their name shape with the static build's
  // cache policy — one definition in @caelo-cms/shared.
  if (!(family === "pinned" ? isPinnedFontSliceFile(file) : FILE_RE.test(file))) return null;
  return join(defaultFontsCacheDir(process.cwd()), family, file);
}

const FONT_URL_RE = /\/_caelo\/fonts\/([a-z0-9-]{1,80})\/([A-Za-z0-9._-]{1,200})/g;

/**
 * Replace every `/_caelo/fonts/<family>/<file>` reference in a preview
 * page with the face as a `data:` URI. A reference whose file is not
 * cached stays as it is: it fails exactly as it would have (the preview
 * already flags unresolvable theme fonts in `missingSlots`).
 *
 * @param read - test seam; reads one cache file.
 */
export async function inlinePreviewFonts(
  html: string,
  read: (path: string) => Promise<Uint8Array> = readFile,
): Promise<string> {
  const refs = new Map<string, string>();
  for (const m of html.matchAll(FONT_URL_RE)) {
    const path = fontCacheFile(m[1] ?? "", m[2] ?? "");
    if (path) refs.set(m[0], path);
  }
  if (refs.size === 0) return html;
  const inlined = new Map<string, string>();
  await Promise.all(
    [...refs].map(async ([url, path]) => {
      try {
        const bytes = await read(path);
        const format = url.split(".").at(-1);
        inlined.set(url, `data:font/${format};base64,${Buffer.from(bytes).toString("base64")}`);
      } catch {
        // Not cached: leave the reference (see the doc comment).
      }
    }),
  );
  return html.replace(FONT_URL_RE, (url) => inlined.get(url) ?? url);
}
