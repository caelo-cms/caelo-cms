// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #667 — which Lighthouse findings come from Caelo itself rather than
 * from the site being built. Pure.
 *
 * On a static Caelo site some audits are decided by the serving and build
 * stack: the document's response time and redirects, the HTTP caching,
 * compression and protocol of Caelo's own files, and response headers that
 * keep a page out of the back/forward cache. Nothing the AI can edit —
 * modules, theme, content, SEO — changes those. The same audits can also be
 * failed by the site, though: a module script registering an `unload`
 * handler blocks the back/forward cache, a third-party file a module embeds
 * can be uncompressed or short-cached. So ownership is decided from the
 * evidence the audit reports (flagged URLs and reasons), not from the audit
 * id alone.
 *
 * Why it matters: the dogfood run that started #667 had the AI recommend
 * accepting "back/forward cache" and "cache lifetimes" because it guessed
 * they came "from the hosting" — both were Caelo bugs (the audit browser
 * disabled the cache by flag; media shipped under non-hashed names with a
 * 1-hour lifetime). The labels are decision support (CLAUDE.md §1A); they
 * do NOT change what blocks Publish live (see gate.ts).
 */

import { TRUNCATED_ELEMENTS_PREFIX, TRUNCATED_ELEMENTS_SUFFIX } from "./lighthouse-extract.js";
import type { FlaggedElement } from "./ratchet.js";

/** Who can fix a failing Lighthouse audit. */
export type FindingOwner =
  /** Decided by Caelo's serving/build stack: report it, don't accept it. */
  | "platform"
  /** Caused by the site (a module's script or embed): fix the module. */
  | "site"
  /** The evidence is mixed or missing: the AI must read the flagged items. */
  | "check";

/** Audits about the main document's delivery: always the serving stack. */
const DOCUMENT_DELIVERY_AUDITS: ReadonlySet<string> = new Set([
  "document-latency-insight",
  "server-response-time",
  "redirects",
]);

/** Audits about how files are served: Caelo's files vs a module's embeds. */
const RESOURCE_SERVING_AUDITS: ReadonlySet<string> = new Set([
  "cache-insight",
  "uses-long-cache-ttl",
  "uses-text-compression",
  "uses-http2",
]);

/** Back/forward-cache blockers that come from the browser setup or the
 *  main document's response headers, not from page script. A subresource
 *  answered with `no-store` (a script's fetch) may be a module's embed or
 *  our gateway, so it stays "check". */
const PLATFORM_BFCACHE_REASON =
  /disabled by (flags|the command line)|main resource has cache-control/i;

/** Same origin as the audited page (a relative or unparsable URL counts as same-site). */
function isSameSite(url: string, pageUrl: string): boolean {
  try {
    return new URL(url, pageUrl).origin === new URL(pageUrl).origin;
  } catch {
    return true;
  }
}

/** Back/forward-cache blockers raised by page script (what a module's JS
 *  does), recognised positively — an unknown reason (e.g. a browser memory
 *  limit) is neither the site's nor Caelo's to fix and stays "check". */
const SITE_BFCACHE_REASON =
  /unload|websocket|webrtc|broadcastchannel|indexeddb|keepalive|web ?lock|worker|outstanding (network|fetch|xhr)|in-?flight|window\.opener|webtransport|webhid|webusb|serial|bluetooth/i;

/** Collapse per-item verdicts: all one way decides, anything else needs a look. */
function verdict(items: readonly ("platform" | "site" | "unknown")[]): FindingOwner | null {
  if (items.length === 0) return null;
  if (items.every((v) => v === "platform")) return "platform";
  if (items.every((v) => v === "site")) return "site";
  return "check";
}

/**
 * Who can fix the failing audit `auditId` on the page at `pageUrl`, judged
 * from the elements / URLs / reasons it flagged.
 *
 * @returns null for audits this module has no opinion on (ordinary site
 *   findings such as `image-alt` or `color-contrast`).
 */
export function findingOwner(
  auditId: string,
  elements: readonly FlaggedElement[],
  pageUrl: string,
): FindingOwner | null {
  if (DOCUMENT_DELIVERY_AUDITS.has(auditId)) return "platform";
  // Only part of the evidence was kept: never decide from a sample.
  const truncated = elements.some(
    (e) =>
      e.label?.startsWith(TRUNCATED_ELEMENTS_PREFIX) === true &&
      e.label.endsWith(TRUNCATED_ELEMENTS_SUFFIX),
  );
  if ((RESOURCE_SERVING_AUDITS.has(auditId) || auditId === "bf-cache") && truncated) {
    return "check";
  }
  if (RESOURCE_SERVING_AUDITS.has(auditId)) {
    const urls = elements.flatMap((e) => (e.url ? [e.url] : []));
    return verdict(urls.map((u) => (isSameSite(u, pageUrl) ? "platform" : "site"))) ?? "check";
  }
  if (auditId === "bf-cache") {
    const reasons = elements.flatMap((e) => (e.explanation ? [e.explanation] : []));
    return (
      verdict(
        reasons.map((r) =>
          PLATFORM_BFCACHE_REASON.test(r)
            ? "platform"
            : SITE_BFCACHE_REASON.test(r)
              ? "site"
              : "unknown",
        ),
      ) ?? "check"
    );
  }
  return null;
}
