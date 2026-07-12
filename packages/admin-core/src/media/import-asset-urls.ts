// SPDX-License-Identifier: MPL-2.0

/**
 * issue #249 (WS3) — pure asset-URL discovery + rewrite for imported
 * module HTML/CSS. No I/O here: `imports.migrate_media` feeds these
 * functions the module bodies, downloads what they find, then splices
 * the Caelo media URLs back in at the exact positions discovery
 * reported, so discovery and rewrite can never disagree about what a
 * "reference" is.
 *
 * Discovery covers the surfaces a crawled page hotlinks assets from:
 * `img src/srcset`, `source src/srcset`, `video src/poster`,
 * `audio src`, and every CSS `url(...)` — which also catches inline
 * `style="background-image: url(...)"` because the whole HTML string
 * is scanned for `url(...)` tokens, not just `<style>` blocks.
 */

import type { MediaMime } from "@caelo-cms/shared";

/** One asset reference found in a text, with its exact token span. */
export interface DiscoveredAssetRef {
  /** Span of the raw URL token inside the scanned text. */
  readonly start: number;
  readonly end: number;
  /** The literal token as it appears in the text. */
  readonly raw: string;
  /** Absolute http(s) URL after resolving against the page's source URL. */
  readonly url: string;
  /** Source `alt` attribute when the ref came from an `<img>` tag. */
  readonly alt?: string;
}

export interface AssetDiscovery {
  /** External http(s) references, ordered by position. */
  readonly refs: DiscoveredAssetRef[];
  /** Count of refs already pointing at Caelo media (`/_caelo/...`) — idempotent re-runs. */
  readonly alreadyLocal: number;
  /** Raw tokens that could not be resolved to a URL at all (reported loudly upstream). */
  readonly unparseable: string[];
}

type Candidate = { start: number; end: number; raw: string; alt?: string };

const MEDIA_TAG_RE = /<(img|source|video|audio)\b[^>]*>/gi;
// Attribute with quoted or bare value; group indices: 2=double, 3=single, 4=bare.
const ASSET_ATTR_RE = /\b(src|srcset|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const ALT_ATTR_RE = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
// CSS url(token): quoted or bare. Bare tokens stop at ')' and quotes.
const CSS_URL_RE = /url\(\s*(?:"([^")]*)"|'([^')]*)'|([^"')][^)]*?))\s*\)/gi;

/**
 * Scan `text` for asset references and resolve them against `baseUrl`
 * (the page's original source URL — relative and protocol-relative
 * references resolve the way the source site's browser resolved them).
 *
 * @param kind - "html" scans media tags AND `url(...)` tokens; "css" scans `url(...)` only.
 */
export function discoverAssetRefs(
  text: string,
  kind: "html" | "css",
  baseUrl: string,
): AssetDiscovery {
  const candidates: Candidate[] = [];

  if (kind === "html") {
    for (const tag of text.matchAll(MEDIA_TAG_RE)) {
      const tagText = tag[0];
      const tagStart = tag.index;
      const isImg = (tag[1] ?? "").toLowerCase() === "img";
      const alt = isImg
        ? (tagText.match(ALT_ATTR_RE)?.[1] ?? tagText.match(ALT_ATTR_RE)?.[2])
        : undefined;
      for (const attr of tagText.matchAll(ASSET_ATTR_RE)) {
        const attrName = (attr[1] ?? "").toLowerCase();
        const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
        if (value === "") continue;
        // Value offset inside the tag: the match ends with the value
        // (plus a closing quote when quoted).
        const quoted = attr[4] === undefined;
        const valueStart = tagStart + attr.index + attr[0].length - value.length - (quoted ? 1 : 0);
        if (attrName === "srcset") {
          candidates.push(...srcsetCandidates(value, valueStart, alt));
        } else {
          candidates.push({ start: valueStart, end: valueStart + value.length, raw: value, alt });
        }
      }
    }
  }

  // url(...) tokens — for HTML this covers inline style attributes and
  // embedded <style> blocks in one pass.
  for (const m of text.matchAll(CSS_URL_RE)) {
    const token = m[1] ?? m[2] ?? m[3] ?? "";
    if (token === "") continue;
    // Token cannot occur inside the "url( <ws> <quote>" prefix, so the
    // first occurrence after "url(" is the real position.
    const tokenStart = m.index + m[0].indexOf(token, 4);
    candidates.push({ start: tokenStart, end: tokenStart + token.length, raw: token });
  }

  candidates.sort((a, b) => a.start - b.start);

  const refs: DiscoveredAssetRef[] = [];
  const unparseable: string[] = [];
  let alreadyLocal = 0;
  let lastEnd = -1;
  for (const c of candidates) {
    // A srcset URL can theoretically be re-matched by the CSS scanner
    // in pathological inputs; overlapping spans would corrupt the
    // splice-rewrite, so keep the first match only.
    if (c.start < lastEnd) continue;
    const resolved = resolveCandidate(c.raw, baseUrl);
    if (resolved.kind === "ignore") continue;
    lastEnd = c.end;
    if (resolved.kind === "local") {
      alreadyLocal += 1;
    } else if (resolved.kind === "unparseable") {
      unparseable.push(c.raw);
    } else {
      refs.push({ start: c.start, end: c.end, raw: c.raw, url: resolved.url, alt: c.alt });
    }
  }
  return { refs, alreadyLocal, unparseable };
}

/** Split a srcset value into URL tokens with exact offsets; descriptors (`2x`, `640w`) stay untouched. */
function srcsetCandidates(value: string, valueStart: number, alt?: string): Candidate[] {
  const out: Candidate[] = [];
  let pos = 0;
  for (const part of value.split(",")) {
    const partStart = pos;
    pos += part.length + 1; // +1 for the comma
    const lead = part.length - part.trimStart().length;
    const token = part.trim().split(/\s+/)[0] ?? "";
    if (token === "") continue;
    const start = valueStart + partStart + lead;
    out.push({ start, end: start + token.length, raw: token, alt });
  }
  return out;
}

type Resolved =
  | { kind: "external"; url: string }
  | { kind: "local" }
  | { kind: "ignore" }
  | { kind: "unparseable" };

function resolveCandidate(raw: string, baseUrl: string): Resolved {
  const t = raw.trim();
  if (t === "" || t.startsWith("#")) return { kind: "ignore" };
  // Template placeholders ({{field}}) are content bindings, not URLs.
  if (t.includes("{{")) return { kind: "ignore" };
  if (/^(data|blob|javascript|mailto|about|tel):/i.test(t)) return { kind: "ignore" };
  if (t.startsWith("/_caelo/")) return { kind: "local" };
  let u: URL;
  try {
    u = new URL(t, baseUrl);
  } catch {
    return { kind: "unparseable" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { kind: "ignore" };
  if (u.pathname.startsWith("/_caelo/")) return { kind: "local" };
  return { kind: "external", url: u.toString() };
}

/**
 * Replace every discovered ref whose resolved URL has a mapping with
 * the mapped (Caelo media) URL. Splices by position, back to front, so
 * a URL that is a prefix of another can never corrupt its neighbour.
 * Refs without a mapping (skipped downloads) are left untouched — the
 * skip is reported, never silently rewritten.
 */
export function rewriteAssetRefs(
  text: string,
  refs: readonly DiscoveredAssetRef[],
  urlMap: ReadonlyMap<string, string>,
): string {
  let out = text;
  const ordered = [...refs].sort((a, b) => b.start - a.start);
  for (const ref of ordered) {
    const replacement = urlMap.get(ref.url);
    if (replacement === undefined) continue;
    out = out.slice(0, ref.start) + replacement + out.slice(ref.end);
  }
  return out;
}

// ---------------------------------------------------------------------
// Content-type gate. The allowlist is images + fonts + pdf (issue #249)
// — NOT video: a 15 MB per-file cap makes video migration useless-by-
// truncation, so it is a loud skip instead of a half-migrated asset.
// ---------------------------------------------------------------------

const MIME_ALIASES: Record<string, MediaMime> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/avif": "image/avif",
  "image/gif": "image/gif",
  "image/svg+xml": "image/svg+xml",
  "application/pdf": "application/pdf",
  "font/woff2": "font/woff2",
  "application/font-woff2": "font/woff2",
  "font/woff": "font/woff",
  "application/font-woff": "font/woff",
  "application/x-font-woff": "font/woff",
  "font/ttf": "font/ttf",
  "font/sfnt": "font/ttf",
  "application/x-font-ttf": "font/ttf",
  "application/font-sfnt": "font/ttf",
  "font/otf": "font/otf",
  "application/x-font-otf": "font/otf",
  "application/vnd.ms-opentype": "font/otf",
};

/**
 * Map a raw `Content-Type` header to the migratable `MediaMime`, or
 * null when the type is outside the migration allowlist.
 */
export function normalizeAssetMime(contentType: string): MediaMime | null {
  const base = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return MIME_ALIASES[base] ?? null;
}

/**
 * Cheap magic-byte plausibility check — a hostile or misconfigured
 * server can label anything `image/png`; storing an HTML body under an
 * image MIME would poison the media library. Rasters get re-validated
 * by sharp anyway; this catches the rest (fonts/pdf/svg) up front.
 */
export function magicBytesMatchMime(mime: MediaMime, bytes: Uint8Array): boolean {
  const startsWith = (sig: number[], offset = 0): boolean =>
    sig.every((b, i) => bytes[offset + i] === b);
  const ascii = (s: string, offset = 0): boolean =>
    startsWith(
      [...s].map((ch) => ch.charCodeAt(0)),
      offset,
    );
  switch (mime) {
    case "image/png":
      return startsWith([0x89, 0x50, 0x4e, 0x47]);
    case "image/jpeg":
      return startsWith([0xff, 0xd8, 0xff]);
    case "image/gif":
      return ascii("GIF8");
    case "image/webp":
      return ascii("RIFF") && ascii("WEBP", 8);
    case "image/avif":
      return ascii("ftyp", 4);
    case "application/pdf":
      return ascii("%PDF");
    case "font/woff2":
      return ascii("wOF2");
    case "font/woff":
      return ascii("wOFF");
    case "font/ttf":
      return startsWith([0x00, 0x01, 0x00, 0x00]) || ascii("true");
    case "font/otf":
      return ascii("OTTO");
    case "image/svg+xml": {
      // SVG is text: accept BOM/XML-prolog/doctype noise, require an
      // <svg element near the top.
      const head = new TextDecoder("utf-8", { fatal: false })
        .decode(bytes.slice(0, 2048))
        .toLowerCase();
      return head.includes("<svg");
    }
    case "video/mp4":
      // Not migratable (see allowlist note) — normalizeAssetMime never
      // yields it, but the switch stays exhaustive over MediaMime.
      return false;
  }
}
