// SPDX-License-Identifier: MPL-2.0

/**
 * #1268 — what the admin shows and does while a navigation loads.
 *
 * A client-side navigation keeps the old page on screen until the new
 * page's data arrived. Without a sign of progress an operator clicks
 * again, and every click started another full server load of the same
 * page (five overlapping loads of `/edit` on searchVIU, 2026-10-31).
 */

/** True when the navigation in flight goes to `href`'s page (any query). */
export function isNavigatingTo(inFlight: URL | null | undefined, href: string): boolean {
  if (!inFlight) return false;
  return inFlight.pathname === new URL(href, inFlight).pathname;
}

/**
 * True when `next` repeats the navigation in flight: same page, same
 * query. Such a click starts no second load; the first one is on its way.
 */
export function isRepeatNavigation(inFlight: URL | null | undefined, next: URL): boolean {
  if (!inFlight) return false;
  return inFlight.pathname === next.pathname && inFlight.search === next.search;
}
