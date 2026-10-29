// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #946 — the shape of every preview DOCUMENT Caelo serves (module HTML
 * is AI-authored or imported from third-party sites and may carry scripts):
 * `PREVIEW_DOCUMENT_CSP` makes its scripts run in an opaque origin, never in
 * the admin's, and fonts are inlined as `data:` URIs because an opaque
 * origin loads them without credentials.
 *
 * Lives in admin-core (not the admin app) since #1217: the capture job serves
 * the same document, with the same headers, to its own browser.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isPinnedFontSliceFile } from "@caelo-cms/shared";
import { defaultFontsCacheDir } from "@caelo-cms/static-generator";

/** CSP of every script-running preview document: scripts yes, admin origin no. */
export const PREVIEW_DOCUMENT_CSP = "sandbox allow-scripts";

/** Response headers of a preview document. */
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
