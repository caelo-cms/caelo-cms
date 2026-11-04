// SPDX-License-Identifier: MPL-2.0
/**
 * The admin's Settings section lived at `/security/*` until issue #684.
 * Those URLs are baked into places we cannot rewrite: chat history and AI
 * tool results, audit rows, notifications, operators' bookmarks, and chat
 * pending strips rendered before an upgrade that still POST Approve to the
 * old queue path. `hooks.server.ts` answers every one of them with a 308 to
 * the same path under `/settings` — 308 (not 301) because it keeps the
 * method and body, so an in-flight form POST lands on the moved action.
 */
const LEGACY_ROOT = "/security";
const SETTINGS_ROOT = "/settings";
/**
 * The `/settings` location for a legacy `/security` URL, query string and
 * all, or null when the URL is not under `/security`.
 *
 * @param url the request URL.
 * @returns a path + search to put in `Location`, or null.
 */
export function legacySecurityRedirect(url) {
    const { pathname, search } = url;
    if (pathname !== LEGACY_ROOT && !pathname.startsWith(`${LEGACY_ROOT}/`))
        return null;
    return `${SETTINGS_ROOT}${pathname.slice(LEGACY_ROOT.length)}${search}`;
}
