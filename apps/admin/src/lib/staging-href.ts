// SPDX-License-Identifier: MPL-2.0

/**
 * Links to a page on the staging site, for server and browser code alike.
 *
 * On an install with a protected staging host (#650) every staging link
 * goes through the admin's "Open staging" route, which signs the operator
 * in on the staging host and lands on the page; never the provider's
 * preview origin. A development checkout serves staging on its local
 * port instead.
 */

/** How this install links to its staging pages; null when it has no staging site to link to. */
export type StagingLinks =
  | { readonly kind: "gate" }
  | { readonly kind: "origin"; readonly origin: string }
  | null;

/**
 * #650 — the admin's link to a page on the protected staging site: the
 * "Open staging" route, which signs the operator in on staging.<domain>
 * and lands on the page. Never the provider's preview origin.
 */
export function openStagingHref(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p === "/" ? "/staging/open" : `/staging/open?path=${encodeURIComponent(p)}`;
}

/** The link to `path` on staging, or null when the install has no staging site to link to. */
export function stagingPageHref(links: StagingLinks, path: string): string | null {
  if (links === null) return null;
  if (links.kind === "gate") return openStagingHref(path);
  return new URL(path.startsWith("/") ? path : `/${path}`, links.origin).toString();
}
