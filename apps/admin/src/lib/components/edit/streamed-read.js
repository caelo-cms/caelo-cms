// SPDX-License-Identifier: MPL-2.0
/**
 * The value if it was loaded for `key`, else null: after a switch to another
 * chat or page, the previous one's value must not stand in for the new one's
 * (a Stage list of the previous chat submitted with the new chat's id).
 */
export function currentFor(s, key) {
    return s.key === key ? s.current : null;
}
/** The failure if it happened for `key`, else null. */
export function errorFor(s, key) {
    return s.key === key ? s.error : null;
}
/** True until a value or failure for `key` arrived. */
export function pendingFor(s, key) {
    return s.loading || s.key !== key;
}
/**
 * The page the editor should show after a load: the one the load opened,
 * when the load was asked for the shown page (`requested`, its `?page=`)
 * and opened another one (the shown page is gone from this chat's view,
 * e.g. the AI deleted it). Null = keep the shown page.
 */
export function pageToFollow(requested, shown, opened) {
    if (shown === "" || requested !== shown || opened === shown)
        return null;
    return opened ?? "";
}
