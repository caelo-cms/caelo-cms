// SPDX-License-Identifier: MPL-2.0
export function isCaeloMessage(value) {
    if (!value || typeof value !== "object")
        return false;
    const k = value.kind;
    return (k === "caelo:ready" ||
        k === "caelo:navigated" ||
        k === "caelo:element-clicked" ||
        k === "caelo:reload" ||
        k === "caelo:set-edit-mode");
}
