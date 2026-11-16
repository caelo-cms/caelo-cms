// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1604 — which render failures are the site's content and which
 * are Caelo's own.
 *
 * A Stage never fails because of the site's content (maintainer decision
 * 2026-11-12): the staging build ships the broken spot as the preview shows
 * it, records it with the run, the Stage's quality audit reports it and
 * Publish live refuses the build until it is repaired. A marker that only a
 * renderer wired up wrongly can produce is no content: no edit repairs it,
 * so such a build still stops and the failure is filed as a Caelo bug.
 *
 * The generator (whether a staging build stops) and the admin (how a
 * stopped build is described, which audit rule a failure files under) both
 * read this, so the two never disagree about a marker.
 */

import { LINK_RESOLVER_UNAVAILABLE } from "./link-refs.js";

/**
 * Markers of a render without its context: a link rendered without a
 * resolver, a nested module without the recursive renderer, a list without
 * the list context. The engine documents each as "never legitimate output".
 */
const CAELO_FAULT_PREFIXES = [
  `${LINK_RESOLVER_UNAVAILABLE}:`,
  "nested-renderer-unavailable:",
  "list-context-unavailable:",
] as const;

/** The nested escape hatch's comment: a nested module rendered without the recursive renderer. */
const NEEDS_RECURSIVE_RENDERER_RE = /needs recursive renderer/;

/** `<!-- caelo:missing reason=<marker> -->` as the backstop records it. */
const MISSING_COMMENT_RE = /^<!--\s*caelo:missing\s+reason=(\S+?)\s*-->$/;

/**
 * The marker a render failure names: its reason, or the marker inside a
 * `caelo:missing` comment the generator's backstop recorded verbatim.
 */
export function renderFailureMarker(reason: string): string {
  return MISSING_COMMENT_RE.exec(reason.trim())?.[1] ?? reason;
}

/**
 * True when no content edit can repair the failure: Caelo rendered without
 * the context the marker names. A build with one still stops.
 */
export function isCaeloFaultMarker(reason: string): boolean {
  if (NEEDS_RECURSIVE_RENDERER_RE.test(reason)) return true;
  const marker = renderFailureMarker(reason);
  return CAELO_FAULT_PREFIXES.some((p) => marker.startsWith(p));
}

/**
 * The kind of a render failure, as an audit rule names it: the marker's
 * prefix (`field-path-unknown`, `module-missing`, `link-target-missing`),
 * or `unrenderable` for a marker without one.
 */
export function renderFailureKind(reason: string): string {
  return /^([a-z][a-z0-9-]{0,60}):/.exec(renderFailureMarker(reason))?.[1] ?? "unrenderable";
}
