// SPDX-License-Identifier: MPL-2.0

/**
 * #650 — the admin's link to a page on the protected staging site: the
 * "Open staging" route, which signs the operator in on staging.<domain>
 * and lands on the page. Never the provider's preview origin.
 */
export function openStagingHref(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p === "/" ? "/staging/open" : `/staging/open?path=${encodeURIComponent(p)}`;
}
