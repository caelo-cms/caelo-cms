// SPDX-License-Identifier: MPL-2.0
/** The array at `field` of a stored manifest, or [] when absent or malformed. */
function entriesOf(manifestJson, field) {
    if (manifestJson === null || typeof manifestJson !== "object")
        return [];
    const raw = manifestJson[field];
    if (!Array.isArray(raw))
        return [];
    return raw.filter((e) => e !== null && typeof e === "object");
}
/** What the manifest asks visitors to consent to, one line per purpose. */
export function consentPurposeLines(manifestJson) {
    return entriesOf(manifestJson, "consentPurposes").map((p) => {
        const cookies = Array.isArray(p.cookies)
            ? p.cookies.map((c) => String(c?.name ?? "")).join(", ")
            : "";
        return {
            key: String(p.key),
            text: `${String(p.key)} — ${String(p.category)}${cookies ? ` (${cookies})` : ""}`,
        };
    });
}
/** The admin pages the manifest declares and who may open them. */
export function adminPanelLines(manifestJson) {
    return entriesOf(manifestJson, "adminPanels").map((p) => ({
        key: String(p.slug),
        text: `${String(p.title)} (needs ${String(p.permission)})`,
    }));
}
/** The live-editor toolbar items the manifest declares and who sees them. */
export function toolbarItemLines(manifestJson) {
    return entriesOf(manifestJson, "editorToolbar").map((p) => ({
        key: String(p.id),
        text: `${String(p.title)} (needs ${String(p.permission)})`,
    }));
}
