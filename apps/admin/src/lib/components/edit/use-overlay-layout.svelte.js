// SPDX-License-Identifier: MPL-2.0
export const DEFAULT_LAYOUT = {
    // Chat-panel UX pass: the chat IS the product's primary surface, so
    // the DEFAULT is a full-height side column (Cursor/Copilot form
    // factor) instead of a 360×480 floating box that forced the
    // onboarding welcome behind two scrollbars. Users who prefer
    // floating drag it out once — the preference persists.
    pin: "pinned-right",
    collapsed: false,
    x: 24,
    y: 80,
    width: 400,
    height: 560,
    pinnedHeight: 320,
    pinnedWidth: 420,
};
const PREFERENCE_KEY = "edit_overlay_layout";
/**
 * Persists `layout` to the server via `user_preferences.set`. Caller is
 * expected to debounce. Errors are swallowed (a failed write is
 * tolerable — next change will retry; user can also just reload).
 */
export async function saveOverlayLayout(csrfToken, layout) {
    try {
        await fetch("/edit/preferences", {
            method: "POST",
            headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
            body: JSON.stringify({ key: PREFERENCE_KEY, value: layout }),
        });
    }
    catch {
        // best-effort; ignore
    }
}
export function debounced(fn, ms) {
    let timer = null;
    return (...args) => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}
