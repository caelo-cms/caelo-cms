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

/**
 * #1600 — a media reference the build's media pass could not publish:
 * `media-variant-missing:<ref>/<variant>:<variants it has, comma-separated>`
 * for a live asset without that variant (a `webp-800` of a 760 px source),
 * `media-missing:<ref>/<variant>` when no live asset answers `<ref>` (its
 * slug, or the legacy asset id). Content, never a Caelo fault: a Stage
 * ships the reference as written and reports it.
 */
export const MEDIA_VARIANT_MISSING = "media-variant-missing";
/** See {@link MEDIA_VARIANT_MISSING}. */
export const MEDIA_MISSING = "media-missing";

/** A media failure marker's parts ({@link MEDIA_VARIANT_MISSING}). */
export interface MediaFailure {
  readonly ref: string;
  readonly variant: string;
  /** The variants the asset has, sorted; null when no live asset answers `ref`. */
  readonly variants: readonly string[] | null;
}

/** The marker of a media reference the build could not publish. */
export function mediaFailureMarker(f: MediaFailure): string {
  return f.variants === null
    ? `${MEDIA_MISSING}:${f.ref}/${f.variant}`
    : `${MEDIA_VARIANT_MISSING}:${f.ref}/${f.variant}:${f.variants.join(",")}`;
}

// Slugs, ids and variant tags are `[a-z0-9-]` (shared media.ts), so `/`,
// `:` and `,` cannot occur inside a part.
const MEDIA_FAILURE_RE =
  /^(media-variant-missing|media-missing):([a-z0-9][a-z0-9-]{0,63})\/([a-z][a-z0-9-]{0,63})(?::([a-z0-9,-]{0,2000}))?$/;

/** The parts of a media failure marker, or null for any other reason. */
export function parseMediaFailureMarker(reason: string): MediaFailure | null {
  const m = MEDIA_FAILURE_RE.exec(renderFailureMarker(reason));
  if (!m) return null;
  const ref = m[2] as string;
  const variant = m[3] as string;
  const list = m[4];
  if (m[1] === MEDIA_MISSING) return list === undefined ? { ref, variant, variants: null } : null;
  return { ref, variant, variants: (list ?? "").split(",").filter((v) => v.length > 0) };
}
