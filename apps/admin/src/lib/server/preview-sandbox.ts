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
 * - The opaque origin cannot store cookies either. The operator's preview
 *   gets a jar of its own that survives reloads (`preview-cookie-jar.ts`),
 *   so a consent decision does not have to be made again on every load.
 */

import { inlinePreviewFonts, previewDocumentHeaders } from "@caelo-cms/admin-core";
import type { Cookies } from "@sveltejs/kit";
import {
  injectPreviewCookieShim,
  PREVIEW_COOKIE_JAR,
  readPreviewCookieJar,
} from "../components/edit/preview-cookie-jar.js";
import { setPreviewAssetGrant } from "./preview-asset-grant.js";

// #1217 — the document shape lives in admin-core (the capture job serves the
// same document); re-exported for the admin's routes and tests.
export {
  fontCacheFile,
  inlinePreviewFonts,
  PREVIEW_DOCUMENT_CSP,
  previewDocumentHeaders,
} from "@caelo-cms/admin-core";

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
 * grant refreshed and the operator's preview cookies restored.
 *
 * @param grant - the operator the media grant is minted for; null for a
 *   caller with its own asset credential (the screenshot capture token),
 *   whose capture starts without cookies like a first-time visitor.
 */
export async function previewDocumentResponse(
  html: string,
  grant: { readonly cookies: Cookies; readonly userId: string } | null,
): Promise<Response> {
  let doc = html;
  if (grant) {
    await setPreviewAssetGrant(grant.cookies, grant.userId);
    doc = injectPreviewCookieShim(doc, readPreviewCookieJar(grant.cookies.get(PREVIEW_COOKIE_JAR)));
  }
  return new Response(await inlinePreviewFonts(doc), { headers: previewDocumentHeaders() });
}
