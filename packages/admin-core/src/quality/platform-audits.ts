// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #667 — which Lighthouse findings come from Caelo itself rather than
 * from the site being built. Pure.
 *
 * On a static Caelo site, some audits are decided entirely by the serving
 * and build stack: HTTP caching headers of Caelo's own files, compression,
 * the protocol, the server's response time, the redirects the hosting
 * answers with, and whether a page can enter the back/forward cache (no
 * module can set response headers). Nothing the AI can edit — modules,
 * theme, content, SEO — changes them. When one of them fails, that is a
 * Caelo bug to report, never a site finding to accept: the dogfood run that
 * started #667 had the AI recommend accepting "back/forward cache" and
 * "cache lifetimes" because it guessed they came "from the hosting", when
 * both were Caelo bugs (the audit browser disabled the cache by flag; media
 * shipped under non-hashed names with a 1-hour lifetime).
 *
 * The labels are decision support for the AI (CLAUDE.md §1A): they say
 * where the fix belongs. They do NOT change what blocks Publish live — see
 * gate.ts for why platform findings still block until fixed or accepted.
 */

/** Who can fix a failing Lighthouse audit. */
export type FindingOwner =
  /** Decided by Caelo's serving/build stack: report it, don't accept it. */
  | "platform"
  /** Caelo's own files are platform; a third-party URL a module embeds is
   *  site content. The flagged URLs decide. */
  | "platform-or-embed"
  /** Fixed by changing the site (modules, theme, media, content, SEO). */
  | "site";

/** Audits only Caelo's serving/build stack decides on a static site. */
const PLATFORM_AUDITS: ReadonlySet<string> = new Set([
  "bf-cache",
  "document-latency-insight",
  "server-response-time",
  "redirects",
  "uses-text-compression",
  "uses-http2",
]);

/** Caching audits: Caelo's files are platform, third-party embeds are not. */
const CACHING_AUDITS: ReadonlySet<string> = new Set(["cache-insight", "uses-long-cache-ttl"]);

/** Who can fix the failing Lighthouse audit `auditId`. */
export function findingOwner(auditId: string): FindingOwner {
  if (PLATFORM_AUDITS.has(auditId)) return "platform";
  if (CACHING_AUDITS.has(auditId)) return "platform-or-embed";
  return "site";
}
